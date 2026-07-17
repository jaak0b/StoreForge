import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import type {
  PaperCalibration,
  PaperCorners,
  PaperKind,
  TracedOutline,
  TracedTool,
  ToolPlacement,
} from '../engine/trace/types';
import { boundsOf } from '../engine/trace/edit';

/**
 * Community shadow boards use a finger relief around 25 mm across; that
 * comfortably fits a fingertip reaching under a tool.
 */
export const DEFAULT_FINGER_HOLE_DIAMETER_MM = 25;

/** Clear interior kept around the pockets when the bin footprint is auto-sized. */
export const AUTO_SIZE_MARGIN_MM = 2;

/**
 * State of the Tool trace tab, kept in a store because the add-bin card's
 * tabs unmount when switched away; the photo itself stays in the vision
 * worker, so this carries only what the UI needs to redraw. The large
 * rectified preview is deliberately non-reactive (shallowRef) pixel data.
 */
export const useToolTrace = defineStore('toolTrace', () => {
  /** Object URL of the loaded photo file, for drawing the corner-picking canvas. */
  const photoUrl = ref<string | null>(null);
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

  /** Bin footprint of the layout; kept in step with autoGridSize unless overridden. */
  const gridX = ref(1);
  const gridY = ref(1);
  /** True when the user typed a footprint; auto sizing stops updating it. */
  const gridManual = ref(false);
  /** Pocket depth applied to newly placed tools, in mm. */
  const defaultDepthMm = ref(20);

  let toolCounter = 0;

  /**
   * Adds a tool from an outline in sheet mm: the outline is recentered on its
   * bounding-box middle so tool-local coordinates sit about the origin, and
   * the tool is placed at the layout origin with the default pocket depth.
   */
  function addTool(outline: TracedOutline, name?: string): TracedTool {
    const bounds = boundsOf(outline);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const recentre = (p: { x: number; y: number }) => ({ x: p.x - cx, y: p.y - cy });
    toolCounter += 1;
    const tool: TracedTool = {
      id: crypto.randomUUID(),
      name: name ?? `Tool ${toolCounter}`,
      outline: {
        outer: outline.outer.map(recentre),
        holes: outline.holes.map((loop) => loop.map(recentre)),
      },
      rotationDeg: 0,
      offsetMm: 0.5,
      mirrored: false,
      fingerHoles: [],
    };
    tools.value.push(tool);
    placements.value.push({
      toolId: tool.id,
      xMm: 0,
      yMm: 0,
      pocketDepthMm: defaultDepthMm.value,
    });
    selectedToolId.value = tool.id;
    return tool;
  }

  function removeTool(toolId: string): void {
    tools.value = tools.value.filter((tool) => tool.id !== toolId);
    placements.value = placements.value.filter((p) => p.toolId !== toolId);
    if (selectedToolId.value === toolId) selectedToolId.value = null;
  }

  function duplicateTool(toolId: string): void {
    const source = tools.value.find((tool) => tool.id === toolId);
    const placement = placements.value.find((p) => p.toolId === toolId);
    if (source === undefined || placement === undefined) return;
    toolCounter += 1;
    const copy: TracedTool = {
      ...(JSON.parse(JSON.stringify(source)) as TracedTool),
      id: crypto.randomUUID(),
      name: `${source.name} copy`,
    };
    tools.value.push(copy);
    // The copy lands offset from the original so the two are both visible.
    placements.value.push({
      toolId: copy.id,
      xMm: placement.xMm + 10,
      yMm: placement.yMm + 10,
      pocketDepthMm: placement.pocketDepthMm,
    });
    selectedToolId.value = copy.id;
  }

  function placementOf(toolId: string): ToolPlacement | undefined {
    return placements.value.find((p) => p.toolId === toolId);
  }

  /** Clears everything back to a fresh Tool trace tab. */
  function reset(): void {
    if (photoUrl.value !== null) URL.revokeObjectURL(photoUrl.value);
    photoUrl.value = null;
    photoSize.value = null;
    corners.value = null;
    calibration.value = null;
    rectifiedPreview.value = null;
    embedReady.value = false;
    encodeMs.value = null;
    tools.value = [];
    placements.value = [];
    selectedToolId.value = null;
    gridX.value = 1;
    gridY.value = 1;
    gridManual.value = false;
    defaultDepthMm.value = 20;
    toolCounter = 0;
  }

  return {
    photoUrl,
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
    gridX,
    gridY,
    gridManual,
    defaultDepthMm,
    addTool,
    removeTool,
    duplicateTool,
    placementOf,
    reset,
  };
});
