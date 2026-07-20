import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import type {
  BrushStroke,
  PaperCalibration,
  PaperCorners,
  PaperKind,
  SamPoint,
  TracedOutline,
  TracedTool,
  ToolPlacement,
  FingerHole,
} from '../engine/trace/types';
import type { LayoutState } from '../engine/trace/layoutModel';
import * as layout from '../engine/trace/layoutModel';

/**
 * Community shadow boards use a finger relief around 25 mm across; that
 * comfortably fits a fingertip reaching under a tool.
 */
export const DEFAULT_FINGER_HOLE_DIAMETER_MM = 25;

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
  /**
   * Photo-store id of the loaded photo when it came from the store (resuming
   * an edit); null for a freshly uploaded photo, which gets a new id on save.
   */
  const sourceId = ref<string | null>(null);
  /** Pixel size of the loaded photo. */
  const photoSize = ref<{ width: number; height: number } | null>(null);
  /** Sheet corners in photo pixels, detected or user-adjusted. */
  const corners = ref<PaperCorners | null>(null);
  const paperKind = ref<PaperKind>('a4');
  /** Calibration of the current rectified sheet, set after rectify. */
  const calibration = ref<PaperCalibration | null>(null);
  /** Rectified sheet preview pixels; non-reactive, redrawn on change. */
  const rectifiedPreview = shallowRef<ImageData | null>(null);
  /** True once the MobileSAM embedding of the rectified sheet is ready. */
  const embedReady = ref(false);
  /** Encoder wall time in ms of the last embedding run, for the readout. */
  const encodeMs = ref<number | null>(null);

  const tools = ref<TracedTool[]>([]);
  const placements = ref<ToolPlacement[]>([]);
  const selectedToolId = ref<string | null>(null);

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
    name?: string,
    clicks: SamPoint[] = [],
    placeAtSheetPosition = false,
    brushStrokes: BrushStroke[] = [],
  ): TracedTool {
    toolCounter += 1;
    const tool = layout.addTool(
      layoutState,
      outline,
      name ?? `Tool ${toolCounter}`,
      defaultDepthMm.value,
      clicks,
      placeAtSheetPosition,
      brushStrokes,
    );
    selectedToolId.value = tool.id;
    return tool;
  }

  function replaceToolOutline(
    toolId: string,
    outline: TracedOutline,
    clicks: SamPoint[],
    brushStrokes: BrushStroke[] = [],
  ): void {
    layout.replaceToolOutline(layoutState, toolId, outline, clicks, brushStrokes);
  }

  function removeTool(toolId: string): void {
    layout.removeTool(layoutState, toolId);
    if (selectedToolId.value === toolId) selectedToolId.value = null;
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

  function toggleFilledHole(toolId: string, holeIndex: number): void {
    layout.toggleFilledHole(layoutState, toolId, holeIndex);
  }

  function setPocketDepth(toolId: string, depthMm: number): void {
    layout.setPocketDepth(layoutState, toolId, depthMm);
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

  /** Clears everything back to a fresh Tool trace tab. */
  function reset(): void {
    if (photoUrl.value !== null) URL.revokeObjectURL(photoUrl.value);
    photoUrl.value = null;
    photoBlob.value = null;
    sourceId.value = null;
    photoSize.value = null;
    corners.value = null;
    calibration.value = null;
    rectifiedPreview.value = null;
    embedReady.value = false;
    encodeMs.value = null;
    tools.value = [];
    placements.value = [];
    selectedToolId.value = null;
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
    toolCounter = 0;
  }

  return {
    photoUrl,
    photoBlob,
    sourceId,
    photoSize,
    corners,
    paperKind,
    calibration,
    rectifiedPreview,
    embedReady,
    encodeMs,
    tools,
    placements,
    selectedToolId,
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
    removeTool,
    duplicateTool,
    moveTool,
    binPlacement,
    toBinLocal,
    enableAutoSize,
    setGridManually,
    setToolTransform,
    toggleFilledHole,
    setPocketDepth,
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
