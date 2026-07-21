<script setup lang="ts">
import { ref, watch } from 'vue';
import type { MeshData } from '../engine/gridfinity/types';
import { useThreeScene } from '../composables/useThreeScene';
import { useBinMesh } from '../composables/useBinMesh';
import { useCavityPaint, type CavityPaintBinding } from '../composables/useCavityPaint';

/**
 * The slim shared display viewport: it draws the bin body and its label and
 * nothing else, over the scene scaffolding in useThreeScene and the two-mesh
 * display in useBinMesh. It carries no gizmo.
 *
 * When a `paint` binding is supplied it also composes the cavity paint layer
 * (useCavityPaint), raycasting against the body mesh it already draws, so the
 * traced tool bin paints with the exact same tools as the cutout editor. The
 * binding is optional: the manual, screw-list and baseplate previews pass none
 * and stay display-only. There is no gizmo to arbitrate against, so the only
 * recovery this wires is aborting a stroke that a pointer interruption left
 * hanging.
 */

const props = defineProps<{
  mesh: MeshData | null;
  label?: MeshData | null;
  /** The cavity paint binding, or absent for a display-only viewport. */
  paint?: CavityPaintBinding | null;
}>();

const binMesh = useBinMesh();

// Constructed only when a binding is given, so a display-only viewport builds
// no cursor geometry or listeners. The binding is read once at mount; the
// consumers that use it mount a fresh viewport when they turn paint on.
const paint = props.paint
  ? useCavityPaint({ ...props.paint, bodyMesh: () => binMesh.bodyMesh })
  : null;

const container = ref<HTMLDivElement | null>(null);

let onPointerCancelRecovery: ((event: PointerEvent) => void) | null = null;

const { context } = useThreeScene(container, {
  onReady: (ctx) => {
    binMesh.sync(ctx, props.mesh, props.label ?? null);
    if (paint) {
      paint.setup(ctx);
      // A pointercancel or lostpointercapture can end a stroke with no
      // pointerup; aborting it here hands the camera back, the same recovery
      // the cutout viewport runs after releasing its gizmo.
      onPointerCancelRecovery = () => paint.abortStroke(ctx);
      ctx.canvas.addEventListener('pointercancel', onPointerCancelRecovery);
      ctx.canvas.addEventListener('lostpointercapture', onPointerCancelRecovery);
    }
  },
  onTeardown: (ctx) => {
    if (paint && onPointerCancelRecovery) {
      ctx.canvas.removeEventListener('pointercancel', onPointerCancelRecovery);
      ctx.canvas.removeEventListener('lostpointercapture', onPointerCancelRecovery);
      onPointerCancelRecovery = null;
    }
    paint?.teardown(ctx);
    binMesh.dispose(ctx);
  },
});

watch(
  () => [props.mesh, props.label ?? null] as const,
  ([mesh, label]) => {
    const ctx = context.value;
    if (ctx) binMesh.sync(ctx, mesh, label);
  },
);

// Switching to pointer mode abandons any stroke in flight and clears the
// cursor, matching the cutout viewport's paint-tool watch (there is no gizmo to
// resync here).
watch(
  () => props.paint?.paintTool() ?? null,
  (tool) => {
    if (!paint) return;
    if (tool !== null) {
      const ctx = context.value;
      if (ctx) paint.abortStroke(ctx);
      paint.hidePaintCursor();
    }
  },
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
