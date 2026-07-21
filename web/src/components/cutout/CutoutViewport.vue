<script setup lang="ts">
import { ref, watch } from 'vue';
import type { PartMeshes } from '../../engine/gridfinity/types';
import type { Vec3Mm } from '../../engine/plan/types';
import type { CutoutGhost, CutoutGhostMoved } from './cutoutGhost';
import { useThreeScene } from '../../composables/useThreeScene';
import { useBinMesh } from '../../composables/useBinMesh';
import { useModelGizmo } from '../../composables/useModelGizmo';
import { useCavityPaint } from '../../composables/useCavityPaint';

/**
 * The cutout bin editor's viewport: the carved bin, the placed models drawn as
 * translucent ghosts, and the gizmo that moves and turns the selected one, plus
 * the cavity paint tools.
 *
 * It is the base viewport (scene, camera, orbit, lighting, grid, bin mesh) with
 * three layers composed on top. The scene scaffolding lives in `useThreeScene`,
 * the bin body and label in `useBinMesh`, the ghosts and gizmo in
 * `useModelGizmo`, and the cavity paint tools in `useCavityPaint`; what stays
 * here is the one place that arbitrates a gizmo drag, a paint stroke and the
 * orbit camera against each other.
 *
 * Two tiers of preview meet here. The carved bin is geometry the worker
 * produced and this component only draws. The ghosts are the imported
 * triangles drawn directly and transformed on the main thread, so a drag runs
 * at frame rate with no CSG at all; the real carve is what the parent starts
 * once the drag ends.
 */

const props = defineProps<{
  /** The carved bin, or null while no carve has landed yet. */
  meshes: PartMeshes | null;
  /** The placed models, in list order. */
  ghosts: CutoutGhost[];
  /** Which model the gizmo is attached to, or null for no selection. */
  selectedModelId: string | null;
  /**
   * Ids of the models the last carve warned about. These are painted red,
   * whether or not they are also the selected model.
   */
  warnedModelIds: readonly string[];
  /** The active paint tool, or null when the gizmo owns the pointer. */
  paintTool: 'add' | 'remove' | 'flatten' | null;
  /** Brush radius in mm, sizing the cursor and the ghost capsules. */
  brushRadiusMm: number;
  /** Flatten cut height in mm, sizing the flatten cursor's preview cylinder. */
  flattenHeightMm: number;
  /** Whether Ctrl+Z has an edit to undo, so the shortcut knows to claim the key. */
  canUndo: boolean;
  /** Whether Ctrl+Y has an edit to redo, so the shortcut knows to claim the key. */
  canRedo: boolean;
  /**
   * The eye button's own sticky toggle. Combined with Tab held (which is
   * temporary and tracked internally) to decide whether the model ghosts are
   * hidden, matching the trace canvas's "hold Tab or eye button" behaviour.
   */
  modelsHiddenButton: boolean;
}>();

const emit = defineEmits<{
  /** A ghost was clicked, or empty space was clicked to clear the selection. */
  'update:selectedModelId': [id: string | null];
  /** The selected model moved. Fires continuously through a drag, and carves nothing. */
  placementChange: [moved: CutoutGhostMoved];
  /** The drag ended. This is the event a fresh carve should start from. */
  placementCommit: [moved: CutoutGhostMoved];
  /**
   * A ghost's exact bounds were recomputed, because it was drawn for the first
   * time or its placement changed from outside a drag. Only this component
   * holds the transformed triangles, so it is the only place these bounds can
   * be measured without keeping a second copy of every model.
   *
   * The tab needs them for the model readout's footprint and resting height
   * rows, and for sizing the bin around the models where they stand.
   */
  boundsChange: [moved: CutoutGhostMoved];
  /** A brush stroke ended: the sampled hit points in bin-local mm. */
  strokeCommit: [points: Vec3Mm[]];
  /** A flatten click landed: the hit point and the clicked surface's outward unit normal. */
  flattenCommit: [centerMm: Vec3Mm, normalMm: Vec3Mm];
  /** A tool shortcut (B, E, S, V or Escape) picked the named tool, or null for pointer mode. */
  setTool: [tool: 'add' | 'remove' | 'flatten' | null];
  /** The [ or ] key stepped the brush radius by this signed amount in mm. */
  stepBrushRadius: [deltaMm: number];
  /** Ctrl+Z (or Cmd+Z) was pressed with an edit to undo. */
  undo: [];
  /** Ctrl+Y (or Cmd+Shift+Z) was pressed with an edit to redo. */
  redo: [];
  /** The "?" key was pressed outside a field, toggling the shortcut help popover. */
  toggleShortcutHelp: [];
}>();

const container = ref<HTMLDivElement | null>(null);

/** The base bin body and label. Its body mesh is what the paint tools raycast against. */
const binDisplay = useBinMesh();

/**
 * The cavity paint layer. It raycasts against the base bin body this viewport
 * draws, and its Tab-held state is combined with the eye button to hide the
 * model ghosts, matching the trace canvas. Declared before the gizmo so the
 * gizmo can read its held state; its onTabHeldChange calls back into the gizmo,
 * which is a closure invoked only on user input, after both exist.
 */
const paint = useCavityPaint({
  paintTool: () => props.paintTool,
  brushRadiusMm: () => props.brushRadiusMm,
  flattenHeightMm: () => props.flattenHeightMm,
  canUndo: () => props.canUndo,
  canRedo: () => props.canRedo,
  bodyMesh: () => binDisplay.bodyMesh,
  onStrokeCommit: (points) => emit('strokeCommit', points),
  onFlattenCommit: (centerMm, normalMm) => emit('flattenCommit', centerMm, normalMm),
  onSetTool: (tool) => emit('setTool', tool),
  onStepBrushRadius: (deltaMm) => emit('stepBrushRadius', deltaMm),
  onUndo: () => emit('undo'),
  onRedo: () => emit('redo'),
  onToggleShortcutHelp: () => emit('toggleShortcutHelp'),
  // Tab held hides every model ghost so the carved bin surface underneath is
  // visible and paintable (the Flatten tool otherwise has to work through the
  // translucent ghost sitting in front of the cavity). Only visibility changes,
  // so releasing Tab shows exactly the ghosts that were there before.
  onTabHeldChange: () => gizmo.applyGhostVisibility(),
});

/**
 * The ghosts and gizmo layer. Its hidden state is either Tab held (tracked in
 * the paint layer) or the eye button, matching the trace canvas.
 */
const gizmo = useModelGizmo({
  ghosts: () => props.ghosts,
  selectedModelId: () => props.selectedModelId,
  warnedModelIds: () => props.warnedModelIds,
  paintActive: () => props.paintTool !== null,
  modelsHidden: () => paint.tabHeld() || props.modelsHiddenButton,
  onSelect: (id) => emit('update:selectedModelId', id),
  onPlacementChange: (moved) => emit('placementChange', moved),
  onPlacementCommit: (moved) => emit('placementCommit', moved),
  onBoundsChange: (moved) => emit('boundsChange', moved),
});

let onPointerUp: ((event: PointerEvent) => void) | null = null;
let onPointerCancelRecovery: ((event: PointerEvent) => void) | null = null;

const { context } = useThreeScene(container, {
  onReady: (ctx) => {
    gizmo.setup(ctx);
    paint.setup(ctx);

    onPointerUp = (event: PointerEvent) =>
      gizmo.selectAtPointer(ctx, event, paint.pointerDownState());
    // One recovery path for both an interrupted gizmo drag and an interrupted
    // paint stroke: the same pointercancel/lostpointercapture that leaves a
    // gizmo drag stuck also leaves a stroke stuck. The gizmo is released first,
    // then the stroke, keeping the arbitration ordering this viewport owns.
    onPointerCancelRecovery = () => {
      gizmo.releaseStuckDrag();
      paint.abortStroke(ctx);
    };
    ctx.canvas.addEventListener('pointerup', onPointerUp);
    ctx.canvas.addEventListener('pointercancel', onPointerCancelRecovery);
    ctx.canvas.addEventListener('lostpointercapture', onPointerCancelRecovery);

    binDisplay.sync(ctx, props.meshes?.body ?? null, props.meshes?.label ?? null);
    gizmo.syncGhosts(ctx);
    gizmo.syncGizmo();
  },
  onTeardown: (ctx) => {
    if (onPointerUp) ctx.canvas.removeEventListener('pointerup', onPointerUp);
    if (onPointerCancelRecovery) {
      ctx.canvas.removeEventListener('pointercancel', onPointerCancelRecovery);
      ctx.canvas.removeEventListener('lostpointercapture', onPointerCancelRecovery);
    }
    onPointerUp = null;
    onPointerCancelRecovery = null;

    paint.teardown(ctx);
    gizmo.teardown(ctx);
    binDisplay.dispose(ctx);
  },
});

/**
 * Reconciling the scene with the props is reactive work, not frame work: the
 * bin mesh, the ghost list and the gizmo attachment each change only when a
 * prop does, so a watcher runs them exactly then rather than the render loop
 * re-deriving them sixty times a second. Every handler guards on the scene
 * existing, because a prop can settle before onReady has built it; onReady runs
 * the same syncs once so the first paint is not left to a prop changing.
 *
 * What genuinely needs the frame loop stays there: the gizmo follows the model
 * it drags through TransformControls itself, and the dragged ghost is skipped
 * in syncGhosts so the placement echoed back through the props never fights the
 * handle. The render loop that draws all of it lives in useThreeScene.
 */
watch(
  () => props.meshes,
  () => {
    const ctx = context.value;
    if (ctx) binDisplay.sync(ctx, props.meshes?.body ?? null, props.meshes?.label ?? null);
  },
);
watch(
  () => props.ghosts,
  () => {
    const ctx = context.value;
    if (ctx) gizmo.syncGhosts(ctx);
  },
);
watch(
  () => props.selectedModelId,
  () => {
    if (!context.value) return;
    gizmo.syncGizmo();
    // The selection tone is settled here rather than in syncGizmo: the
    // ghost that lost the selection and the one that gained it both change
    // colour, and neither changed the ghost list that syncGhosts repaints from.
    gizmo.paintGhosts();
    gizmo.applyGhostVisibility();
  },
);
watch(
  () => props.warnedModelIds,
  () => {
    if (context.value) gizmo.paintGhosts();
  },
  { deep: true },
);
/** The eye button's sticky toggle combines with Tab held; either hides the ghosts. */
watch(
  () => props.modelsHiddenButton,
  () => gizmo.applyGhostVisibility(),
);

/**
 * While a paint tool is active, both gizmos let go of whatever they held so a
 * drag never fights a stroke, and any stroke already in flight (a tool
 * switch mid-drag) is abandoned rather than left to commit half-drawn.
 * Returning to null hands the gizmos back to the current selection.
 */
watch(
  () => props.paintTool,
  (tool) => {
    const ctx = context.value;
    if (tool !== null) {
      if (ctx) paint.abortStroke(ctx);
      paint.hidePaintCursor();
    }
    gizmo.syncGizmo();
  },
  { immediate: true },
);
</script>

<template>
  <div ref="container" class="viewport" />
</template>

<style scoped>
.viewport {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 420px;
}
</style>
