// The shared top-down mm canvas: the single home for the view math every
// plan-view editor needs (the trace layout view, the divider wall editor).
// It owns the world-to-canvas mapping, the responsive pixel width, the
// frozen-view-at-drag-start rule, the mm mapping under the pointer, and the
// rendering of the bin interior outline with its dotted 42 mm cell
// boundaries. A consumer supplies the bin rectangle to fit and a callback
// that draws its own content in that mapping, and wires the pointer events it
// needs; no consumer recomputes the scale, the centre or the mm conversion.
import { nextTick, onMounted, onUnmounted, ref, type Ref } from 'vue';
import { PITCH } from '../engine/gridfinity/constants';
import { pointSegmentDistance } from '../engine/gridfinity/dividerModel';
import type { MmPoint } from '../engine/trace/types';

/** The world-to-canvas mapping: scale plus the world point at canvas centre. */
export interface ViewTransform {
  s: number;
  cxMm: number;
  cyMm: number;
  heightPx: number;
}

/**
 * The bin the view fits itself around: its footprint in cells plus its
 * interior rectangle in the consumer's mm frame. The trace layout passes its
 * derived world-frame placement; the divider editor passes the bin-centred
 * interior of the designed footprint.
 */
export interface CanvasBin {
  gridX: number;
  gridY: number;
  minX: number;
  minY: number;
  widthMm: number;
  heightMm: number;
}

/** What a consumer's draw callback receives: the mapping, already applied. */
export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  view: ViewTransform;
  bin: CanvasBin;
  toPx: (p: MmPoint) => [number, number];
}

export interface TopDownCanvasOptions {
  /** The bin rectangle the view fits around, read fresh on every draw. */
  bin: () => CanvasBin;
  /** Draws the consumer's own content over the outline and cell boundaries. */
  drawContent: (context: DrawContext) => void;
  /** World mm shown around the bin interior when fitting the view. */
  slackMm?: number;
  /** The view never grows taller than this, however wide the container is. */
  maxHeightPx?: number;
  /** The canvas never renders narrower than this. */
  minWidthPx?: number;
}

const DEFAULT_SLACK_MM = 15;
const DEFAULT_MAX_HEIGHT_PX = 640;
const DEFAULT_MIN_WIDTH_PX = 320;

/** Distance from a point to the segment a-b, the shared hit-test primitive. */
export function segmentDistance(p: MmPoint, a: MmPoint, b: MmPoint): number {
  return pointSegmentDistance(p.x, p.y, a.x, a.y, b.x, b.y);
}

export interface TopDownCanvas {
  canvas: Ref<HTMLCanvasElement | null>;
  /** Template ref binding for the canvas element: bind with :ref="setCanvas". */
  setCanvas: (el: unknown) => void;
  canvasWidth: Ref<number>;
  /** Cursor shown over the canvas; consumers set it from their hit tests. */
  hoverCursor: Ref<string>;
  /** Redraws immediately: outline, cell boundaries, then the consumer's content. */
  draw: () => void;
  /** Redraws after the next DOM update, for watchers on reactive sources. */
  scheduleDraw: () => void;
  /** The mapping in force right now: the frozen one mid-drag, else a fresh fit. */
  currentView: () => ViewTransform;
  /** Client (pointer event) coordinates to mm in the consumer's frame. */
  clientToMm: (clientX: number, clientY: number) => MmPoint;
  /** A screen distance in css pixels as a distance in the consumer's mm frame. */
  cssPxToMm: (px: number) => number;
  /**
   * Pins the mapping for the duration of a drag, so the mm point under the
   * pointer never shifts while the bin resizes underneath it.
   */
  freezeView: () => void;
  /** Releases the pinned mapping and refits to wherever the bin ended up. */
  releaseView: () => void;
}

export function useTopDownCanvas(options: TopDownCanvasOptions): TopDownCanvas {
  const slackMm = options.slackMm ?? DEFAULT_SLACK_MM;
  const maxHeightPx = options.maxHeightPx ?? DEFAULT_MAX_HEIGHT_PX;
  const minWidthPx = options.minWidthPx ?? DEFAULT_MIN_WIDTH_PX;

  const canvas = ref<HTMLCanvasElement | null>(null);
  const canvasWidth = ref(640);
  const hoverCursor = ref('default');

  /** Fits the view to the bin plus slack on every side. */
  function fitView(): ViewTransform {
    const bin = options.bin();
    const w = bin.widthMm + 2 * slackMm;
    const h = bin.heightMm + 2 * slackMm;
    // Fill the container width, but never taller than the height cap; the
    // spare width just shows more world around the bin.
    const s = Math.min(canvasWidth.value / w, maxHeightPx / h);
    return {
      s,
      cxMm: bin.minX + bin.widthMm / 2,
      cyMm: bin.minY + bin.heightMm / 2,
      heightPx: Math.round(h * s),
    };
  }

  /** Frozen at pointerdown so the viewport never moves mid-drag. */
  let frozenView: ViewTransform | null = null;

  function currentView(): ViewTransform {
    return frozenView ?? fitView();
  }

  function draw(): void {
    const el = canvas.value;
    if (!el) return;
    const view = currentView();
    const bin = options.bin();
    const s = view.s;
    el.width = canvasWidth.value;
    el.height = view.heightPx;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, el.width, el.height);
    const toPx = (p: MmPoint): [number, number] => [
      el.width / 2 + (p.x - view.cxMm) * s,
      el.height / 2 + (p.y - view.cyMm) * s,
    ];
    // Interior outline, at the bin's position in the consumer's frame.
    const [binX, binY] = toPx({ x: bin.minX, y: bin.minY });
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(binX, binY, bin.widthMm * s, bin.heightMm * s);
    // Dotted lines on the 42 mm cell boundaries, so it is visible which grid
    // cells the contents occupy.
    ctx.save();
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    const binCxMm = bin.minX + bin.widthMm / 2;
    const binCyMm = bin.minY + bin.heightMm / 2;
    for (let k = 1; k < bin.gridX; k++) {
      const [x] = toPx({ x: binCxMm + (k - bin.gridX / 2) * PITCH, y: 0 });
      ctx.beginPath();
      ctx.moveTo(x, binY);
      ctx.lineTo(x, binY + bin.heightMm * s);
      ctx.stroke();
    }
    for (let k = 1; k < bin.gridY; k++) {
      const [, y] = toPx({ x: 0, y: binCyMm + (k - bin.gridY / 2) * PITCH });
      ctx.beginPath();
      ctx.moveTo(binX, y);
      ctx.lineTo(binX + bin.widthMm * s, y);
      ctx.stroke();
    }
    ctx.restore();
    options.drawContent({ ctx, view, bin, toPx });
  }

  function scheduleDraw(): void {
    void nextTick(draw);
  }

  function clientToMm(clientX: number, clientY: number): MmPoint {
    const el = canvas.value!;
    const rect = el.getBoundingClientRect();
    const view = currentView();
    return {
      x: view.cxMm + (((clientX - rect.left) / rect.width) * el.width - el.width / 2) / view.s,
      y: view.cyMm + (((clientY - rect.top) / rect.height) * el.height - el.height / 2) / view.s,
    };
  }

  /**
   * A distance on screen, in css pixels, as a distance in the consumer's mm
   * frame. The backing store is laid out at its own pixel size and then scaled
   * to fit the element, so the view scale alone is not the figure a css pixel
   * is worth; this folds in that element-to-backing-store ratio, the same one
   * clientToMm applies to a pointer position. Consumers expressing a
   * screen-space affordance (a grab radius, a snap pull) convert it here
   * rather than reaching for view.s and getting the ratio wrong.
   */
  function cssPxToMm(px: number): number {
    const el = canvas.value;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return 0;
    return (px * (el.width / rect.width)) / currentView().s;
  }

  function freezeView(): void {
    frozenView = fitView();
  }

  function releaseView(): void {
    frozenView = null;
    draw();
  }

  // The canvas fills its container; a ResizeObserver keeps the pixel width in
  // step with the layout (drawer opening and closing, window resizes).
  let resizeObserver: ResizeObserver | null = null;
  onMounted(() => {
    const parent = canvas.value?.parentElement;
    if (parent) {
      resizeObserver = new ResizeObserver((entries) => {
        const width = Math.floor(entries[0].contentRect.width);
        if (width > 0) canvasWidth.value = Math.max(minWidthPx, width);
      });
      resizeObserver.observe(parent);
    }
    scheduleDraw();
  });
  onUnmounted(() => resizeObserver?.disconnect());

  function setCanvas(el: unknown): void {
    canvas.value = el instanceof HTMLCanvasElement ? el : null;
  }

  return {
    canvas,
    setCanvas,
    canvasWidth,
    hoverCursor,
    draw,
    scheduleDraw,
    currentView,
    clientToMm,
    cssPxToMm,
    freezeView,
    releaseView,
  };
}
