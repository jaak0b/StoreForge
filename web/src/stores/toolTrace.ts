import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import type {
  PaperCalibration,
  PaperCorners,
  PaperKind,
  TracedOutline,
  TracedTool,
  ToolPlacement,
  ToolSource,
  FingerHole,
  TraceSession,
} from '../engine/trace/types';
import type { LayoutState } from '../engine/trace/layoutModel';
import * as layout from '../engine/trace/layoutModel';
import { createCavityEditSession } from './cavityEditSession';
import { embedImage, loadPhoto, rectifyPaper } from '../visionClient';

/**
 * Community shadow boards use a finger relief around 25 mm across; that
 * comfortably fits a fingertip reaching under a tool.
 */
const DEFAULT_FINGER_HOLE_DIAMETER_MM = 25;

/**
 * Pocket clearance presets in mm around a traced outline, from a snug fit to
 * a loose drop-in; the selection toolbar and the advanced drawer offer the
 * same list.
 */
export const CLEARANCE_CHOICES = [0, 0.5, 1.5, 3, 4.5];

/**
 * Minimum hole width presets in mm, offered by the advanced drawer. 0 keeps
 * every hole; the rest are multiples of the 0.4 mm extrusion line (two, four
 * and eight lines), so each choice is a whole number of printed perimeters an
 * island would stand on before it is filled in instead.
 */
export const HOLE_WIDTH_CHOICES = [0, 0.8, 1.6, 3.2];

/**
 * State of the Tool trace tab, kept in a store because the add-bin card's
 * tabs unmount when switched away; the photo itself stays in the vision
 * worker, so this carries only what the UI needs to redraw. The large
 * rectified preview is deliberately non-reactive (shallowRef) pixel data.
 * All layout mutations (placement, sizing, transforms, finger holes) are
 * thin wrappers over engine/trace/layoutModel, which is the single home for
 * that logic.
 */
export const useToolTrace = defineStore('toolTrace', () => {
  /** Object URL of the loaded photo file, for drawing the corner-picking canvas. */
  const photoUrl = ref<string | null>(null);
  /** The loaded photo's original bytes, stored with the entry on save. */
  const photoBlob = shallowRef<Blob | null>(null);
  /** Pixel size of the loaded photo. */
  const photoSize = ref<{ width: number; height: number } | null>(null);
  /** Sheet corners in photo pixels, detected or user-adjusted. */
  const corners = ref<PaperCorners | null>(null);
  const paperKind = ref<PaperKind>('a4');
  /** Calibration of the current rectified sheet, set after rectify. */
  const calibration = ref<PaperCalibration | null>(null);
  /** Rectified sheet preview pixels; non-reactive, redrawn on change. */
  const rectifiedPreview = shallowRef<ImageData | null>(null);
  /** Encoder wall time in ms of the last embedding run, for the readout. */
  const encodeMs = ref<number | null>(null);

  /** The bin's trace sessions: every photographed sheet, saved or pending. */
  const sessions = ref<TraceSession[]>([]);
  /**
   * Photo bytes by session id, for sessions whose photo is loaded on this
   * page (a fresh upload, or a stored photo fetched for re-tracing).
   * Deliberately a plain Map outside reactivity: blobs are multi-megabyte.
   */
  const sessionBlobs = new Map<string, Blob>();
  /** The session the single-photo working state below belongs to. */
  const activeSessionId = ref<string | null>(null);
  /**
   * The session id the current MobileSAM embedding was computed for. Kept
   * separately from activeSessionId so a half-finished activation reads as
   * not ready: embedReady is true only when the two agree, which makes it
   * impossible for a re-trace to run against a stale sheet's calibration.
   */
  const embedReadySessionId = ref<string | null>(null);
  /** True once the embedding of the ACTIVE session's rectified sheet is ready. */
  const embedReady = computed(
    () => activeSessionId.value !== null && embedReadySessionId.value === activeSessionId.value,
  );

  const tools = ref<TracedTool[]>([]);
  const placements = ref<ToolPlacement[]>([]);
  const selectedToolId = ref<string | null>(null);
  /**
   * Set by a re-finish that could not carry over every filled hole (an
   * unmatched part, or a hole index that no longer exists on its matched
   * part); shown as a non-blocking notice alongside the pocket warnings until
   * the next re-finish or a workspace reset clears it.
   */
  const refinishNotice = ref<string | null>(null);

  /** Which canvas the trace-and-layout workspace shows. */
  const workspaceMode = ref<'trace' | 'layout'>('layout');
  /**
   * Id of a tool whose stored clicks should be reloaded into the trace
   * canvas; set by the tool rail's re-trace button and consumed by the
   * canvas once the embedding is ready.
   */
  const retraceRequestId = ref<string | null>(null);
  /** True while a click on the layout canvas places a finger hole. */
  const fingerHoleMode = ref(false);
  const fingerHoleDiameterMm = ref(DEFAULT_FINGER_HOLE_DIAMETER_MM);
  /** True while a click on the layout canvas fills the hole under it. */
  const fillHolesMode = ref(false);
  /**
   * True when the photo has strong cast shadows around the tools, which turns
   * on the segmentation shadow and paper-halo post-filter. Off by default,
   * because that filter cannot tell a gray shadow from a gray metal tool and
   * would delete a bare metal or chrome tool from the mask.
   */
  const removeShadows = ref(false);

  /**
   * Bin footprint in cells: the layout's required footprint while auto-sized,
   * the typed floor while gridManual is true. The derived footprint
   * (binPlacement) is what the canvas and the generated bin use.
   */
  const gridX = ref(1);
  const gridY = ref(1);
  /** True when the user typed a footprint; the typed size acts as a floor. */
  const gridManual = ref(false);
  /**
   * Pocket depth applied to newly placed tools, in mm. 20 mm fits most hand
   * tool bodies (pliers, wrenches, screwdriver heads) while leaving grip
   * above the pocket for lifting the tool out.
   */
  const defaultDepthMm = ref(20);

  /**
   * The traced bin's manual cavity edits and their tool state, shared with the
   * cutout flow through the same session factory. Its own instance, so the
   * trace tab keeps an edit list and brush settings independent of the cutout
   * tab's.
   */
  const editSession = createCavityEditSession();

  let toolCounter = 0;

  /**
   * The store's reactive refs presented as the layout model's mutable state:
   * the model's actions mutate this view and the changes land in the refs.
   */
  const layoutState: LayoutState = {
    get tools() {
      return tools.value;
    },
    set tools(value) {
      tools.value = value;
    },
    get placements() {
      return placements.value;
    },
    set placements(value) {
      placements.value = value;
    },
    get gridX() {
      return gridX.value;
    },
    set gridX(value) {
      gridX.value = value;
    },
    get gridY() {
      return gridY.value;
    },
    set gridY(value) {
      gridY.value = value;
    },
    get gridManual() {
      return gridManual.value;
    },
    set gridManual(value) {
      gridManual.value = value;
    },
  };

  function addTool(
    outline: TracedOutline,
    name: string | undefined,
    source: ToolSource,
    placeAtSheetPosition = false,
  ): TracedTool {
    toolCounter += 1;
    const tool = layout.addTool(
      layoutState,
      outline,
      name ?? `Tool ${toolCounter}`,
      defaultDepthMm.value,
      source,
      placeAtSheetPosition,
    );
    selectedToolId.value = tool.id;
    return tool;
  }

  function replaceToolOutline(toolId: string, outline: TracedOutline, source: ToolSource): void {
    layout.replaceToolOutline(layoutState, toolId, outline, source);
  }

  /** Adds a tool from one or more outlines (the sketch finish flow's new-tool
   * path, which can produce several selected regions as separate parts). */
  function addToolParts(
    outlines: TracedOutline[],
    name: string | undefined,
    source: ToolSource,
    placeAtSheetPosition = false,
  ): TracedTool {
    toolCounter += 1;
    const tool = layout.addToolParts(
      layoutState,
      outlines,
      name ?? `Tool ${toolCounter}`,
      defaultDepthMm.value,
      source,
      placeAtSheetPosition,
    );
    selectedToolId.value = tool.id;
    return tool;
  }

  /** Replaces an existing tool's parts (the sketch re-finish path). Clears
   * filledHoles the same as replaceToolOutline; the caller remaps them
   * afterward via setFilledHoles when carrying them over by geometry. */
  function replaceToolParts(toolId: string, outlines: TracedOutline[], source: ToolSource): void {
    layout.replaceToolParts(layoutState, toolId, outlines, source);
  }

  /** Replaces a tool's manually filled holes list wholesale. */
  function setFilledHoles(
    toolId: string,
    filledHoles: { partIndex: number; holeIndex: number }[],
  ): void {
    layout.setFilledHoles(layoutState, toolId, filledHoles);
  }

  function removeTool(toolId: string): void {
    layout.removeTool(layoutState, toolId);
    if (selectedToolId.value === toolId) selectedToolId.value = null;
  }

  /**
   * Removes a photo sheet session and, cascading, every tool sourced from it
   * (and that tool's placement, through layout.removeTool). Sketch and
   * primitive tools are untouched, since they do not reference a session.
   * Clears the active photo working state first when the removed session is
   * the active one, so no stale state points at a session that no longer
   * exists. Orphaned photo blobs are swept later by the existing
   * reference-counted sweep (engine/plan/storedAssets.ts), which runs from
   * the current set of queue entries; nothing here needs to delete the blob
   * directly.
   */
  function removeSession(sessionId: string): void {
    if (activeSessionId.value === sessionId) clearActivePhotoState();
    sessions.value = sessions.value.filter((s) => s.id !== sessionId);
    sessionBlobs.delete(sessionId);
    const toolIdsToRemove = tools.value
      .filter((t) => t.source.kind === 'photo' && t.source.sessionId === sessionId)
      .map((t) => t.id);
    for (const toolId of toolIdsToRemove) {
      layout.removeTool(layoutState, toolId);
      if (selectedToolId.value === toolId) selectedToolId.value = null;
    }
  }

  function duplicateTool(toolId: string): void {
    const copy = layout.duplicateTool(layoutState, toolId);
    if (copy !== null) selectedToolId.value = copy.id;
  }

  function moveTool(toolId: string, xMm: number, yMm: number): void {
    layout.moveTool(layoutState, toolId, xMm, yMm);
  }

  /** Where the bin sits in the world frame, derived live from the layout. */
  const binPlacement = computed(() => layout.binPlacement(layoutState));

  /** The layout in the pocket generator's bin-centred coordinates. */
  function toBinLocal(): ReturnType<typeof layout.toBinLocal> {
    return layout.toBinLocal(layoutState);
  }

  function enableAutoSize(): void {
    layout.enableAutoSize(layoutState);
  }

  function setGridManually(axis: 'x' | 'y', value: number): number {
    return layout.setGridManually(layoutState, axis, value);
  }

  function setToolTransform(
    toolId: string,
    patch: Partial<Pick<TracedTool, 'rotationDeg' | 'mirrored' | 'offsetMm' | 'minHoleWidthMm'>>,
  ): void {
    layout.setToolTransform(layoutState, toolId, patch);
  }

  function toggleFilledHole(toolId: string, partIndex: number, holeIndex: number): void {
    layout.toggleFilledHole(layoutState, toolId, partIndex, holeIndex);
  }

  function setPocketDepth(toolId: string, depthMm: number): void {
    layout.setPocketDepth(layoutState, toolId, depthMm);
  }

  function setDraftAngle(toolId: string, draftAngleDeg: number): void {
    layout.setDraftAngle(layoutState, toolId, draftAngleDeg);
  }

  function addFingerHole(toolId: string, hole: FingerHole): FingerHole | null {
    return layout.addFingerHole(layoutState, toolId, hole);
  }

  function moveFingerHole(hole: FingerHole, dxMm: number, dyMm: number): void {
    layout.moveFingerHole(layoutState, hole, dxMm, dyMm);
  }

  function stretchFingerHole(hole: FingerHole, x2Mm: number, y2Mm: number): void {
    layout.stretchFingerHole(layoutState, hole, x2Mm, y2Mm);
  }

  function stretchFingerHoleStart(hole: FingerHole, xMm: number, yMm: number): void {
    layout.stretchFingerHoleStart(layoutState, hole, xMm, yMm);
  }

  function finishFingerHole(hole: FingerHole, minSlotMm: number): void {
    layout.finishFingerHole(layoutState, hole, minSlotMm);
  }

  function removeFingerHole(tool: TracedTool, index: number): void {
    layout.removeFingerHole(layoutState, tool, index);
  }

  function setFingerHoleDiameter(hole: FingerHole, diameterMm: number): void {
    layout.setFingerHoleDiameter(layoutState, hole, diameterMm);
  }

  function placementOf(toolId: string): ToolPlacement | undefined {
    return placements.value.find((p) => p.toolId === toolId);
  }

  /** Clears the single-photo working state; every activation path starts here. */
  function clearActivePhotoState(): void {
    if (photoUrl.value !== null && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(photoUrl.value);
    }
    photoUrl.value = null;
    photoBlob.value = null;
    photoSize.value = null;
    corners.value = null;
    calibration.value = null;
    rectifiedPreview.value = null;
    embedReadySessionId.value = null;
    encodeMs.value = null;
    activeSessionId.value = null;
  }

  /**
   * Registers a freshly uploaded photo as a new pending session and makes it
   * active. The session enters the sessions list once its sheet corners are
   * confirmed (commitSessionPaper); until then it exists only as the active
   * working state plus its blob.
   */
  function startPhotoSession(
    blob: Blob,
    url: string,
    size: { width: number; height: number },
  ): string {
    clearActivePhotoState();
    const id = crypto.randomUUID();
    sessionBlobs.set(id, blob);
    activeSessionId.value = id;
    photoBlob.value = blob;
    photoUrl.value = url;
    photoSize.value = size;
    return id;
  }

  /**
   * Records the active session's confirmed paper setup from the current
   * calibration, inserting the session into the list or updating it in place
   * (corners re-confirmed after an adjustment).
   */
  function commitSessionPaper(): void {
    const id = activeSessionId.value;
    const cal = calibration.value;
    if (id === null || cal === null) return;
    const paper = {
      corners: JSON.parse(JSON.stringify(cal.corners)) as PaperCorners,
      kind: cal.kind,
    };
    const existing = sessions.value.find((s) => s.id === id);
    if (existing !== undefined) {
      existing.paper = paper;
    } else {
      sessions.value.push({ id, traceSourceId: crypto.randomUUID(), paper });
    }
  }

  /**
   * Atomically makes a session the active one: clears every piece of the
   * prior sheet's state first (so nothing stale can be read mid-switch),
   * then loads the session's photo into the vision worker, applies its saved
   * corners without re-detection, rectifies and embeds. embedReady turns
   * true only at the very end and only for this session. Worker failures
   * propagate to the caller, which shows the message; the state is left
   * cleared, never half-activated.
   */
  async function activateSession(sessionId: string, blob: Blob): Promise<void> {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (session === undefined) {
      throw new Error('The photo sheet to activate is not part of this bin.');
    }
    clearActivePhotoState();
    activeSessionId.value = sessionId;
    sessionBlobs.set(sessionId, blob);
    const info = await loadPhoto(await blob.arrayBuffer());
    photoBlob.value = blob;
    photoUrl.value =
      typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
    photoSize.value = info;
    corners.value = JSON.parse(JSON.stringify(session.paper.corners)) as PaperCorners;
    paperKind.value = session.paper.kind;
    const rectified = await rectifyPaper(session.paper.corners, session.paper.kind);
    calibration.value = rectified.calibration;
    rectifiedPreview.value = rectified.preview;
    const embed = await embedImage();
    encodeMs.value = embed.encodeMs;
    embedReadySessionId.value = sessionId;
  }

  /** Clears everything back to a fresh Tool trace tab. */
  function reset(): void {
    clearActivePhotoState();
    sessions.value = [];
    sessionBlobs.clear();
    tools.value = [];
    placements.value = [];
    selectedToolId.value = null;
    refinishNotice.value = null;
    workspaceMode.value = 'layout';
    retraceRequestId.value = null;
    fingerHoleMode.value = false;
    fingerHoleDiameterMm.value = DEFAULT_FINGER_HOLE_DIAMETER_MM;
    fillHolesMode.value = false;
    removeShadows.value = false;
    gridX.value = 1;
    gridY.value = 1;
    gridManual.value = false;
    defaultDepthMm.value = 20;
    editSession.resetEditSession();
    toolCounter = 0;
  }

  return {
    ...editSession,
    photoUrl,
    photoBlob,
    photoSize,
    corners,
    paperKind,
    calibration,
    rectifiedPreview,
    embedReady,
    embedReadySessionId,
    encodeMs,
    sessions,
    sessionBlobs,
    activeSessionId,
    startPhotoSession,
    commitSessionPaper,
    activateSession,
    tools,
    placements,
    selectedToolId,
    refinishNotice,
    workspaceMode,
    retraceRequestId,
    fingerHoleMode,
    fingerHoleDiameterMm,
    fillHolesMode,
    removeShadows,
    gridX,
    gridY,
    gridManual,
    defaultDepthMm,
    addTool,
    replaceToolOutline,
    addToolParts,
    replaceToolParts,
    setFilledHoles,
    removeTool,
    removeSession,
    duplicateTool,
    moveTool,
    binPlacement,
    toBinLocal,
    enableAutoSize,
    setGridManually,
    setToolTransform,
    toggleFilledHole,
    setPocketDepth,
    setDraftAngle,
    addFingerHole,
    moveFingerHole,
    stretchFingerHole,
    stretchFingerHoleStart,
    finishFingerHole,
    removeFingerHole,
    setFingerHoleDiameter,
    placementOf,
    reset,
  };
});
