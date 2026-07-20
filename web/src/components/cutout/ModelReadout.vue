<script setup lang="ts">
import { computed } from 'vue';
import type { MeshBounds } from '../../engine/cutout/cutoutMesh';
import type { SizeMm } from '../../engine/cutout/cutoutBin';
import { fitsInterior, restingHeightMm } from '../../engine/cutout/binEnvelope';
import type { CutoutModel } from '../../engine/plan/types';

/**
 * The selected model's state as labeled rows of raw values: where it sits, how
 * it is turned, how large it is, and whether it is inside the bin.
 *
 * Every row is a readout and none of them is an input. The gizmo in the
 * viewport is the only thing that writes a position or a rotation, so these
 * rows exist to let the user read off exactly where a free drag landed. The
 * clearance is the one value the user reasons about numerically instead of by
 * eye, and it is entered on the model's own row in the list rather than here.
 */

const props = defineProps<{
  /** The selected model, or null when nothing is selected. */
  model: CutoutModel | null;
  /**
   * Exact bounds of the model as placed, in bin-local mm, without the
   * clearance. Null while the model's triangles are not loaded, which is the
   * case for a model whose file this device does not have.
   */
  bounds: MeshBounds | null;
  /** The bin interior the placement is judged against. */
  interior: MeshBounds;
  /**
   * The placed pocket's own size, clearance included, as the last carve
   * measured it. Null until a carve has landed for this model.
   */
  pocketSizeMm: SizeMm | null;
}>();

/** Millimetres, to hundredths: finer than any printer resolves, and stable to read. */
function mm(value: number): string {
  return `${value.toFixed(2)} mm`;
}

function deg(value: number): string {
  return `${value.toFixed(2)} deg`;
}

interface ReadoutRow {
  label: string;
  value: string;
}

const rows = computed<ReadoutRow[]>(() => {
  const model = props.model;
  if (model === null) return [];
  const placement = model.placement;
  const list: ReadoutRow[] = [
    { label: 'Position X', value: mm(placement.xMm) },
    { label: 'Position Y', value: mm(placement.yMm) },
    { label: 'Position Z', value: mm(placement.zMm) },
    { label: 'Rotation X', value: deg(placement.rotXDeg) },
    { label: 'Rotation Y', value: deg(placement.rotYDeg) },
    { label: 'Rotation Z', value: deg(placement.rotZDeg) },
    {
      label: 'Model size',
      value: `${model.sizeMm.x.toFixed(2)} × ${model.sizeMm.y.toFixed(2)} × ${model.sizeMm.z.toFixed(2)} mm`,
    },
    { label: 'Triangles', value: String(model.triangleCount) },
    { label: 'Clearance', value: mm(model.clearanceMm) },
  ];
  // A rescaled model states plainly that it was rescaled, rather than leaving
  // the user to infer it from a size that looks right.
  if (model.unitScale !== 1) {
    list.push({ label: 'Unit scale', value: `× ${model.unitScale}` });
  }
  if (props.bounds !== null) {
    list.push({
      label: 'Footprint',
      value: `${props.bounds.sizeX.toFixed(2)} × ${props.bounds.sizeY.toFixed(2)} mm`,
    });
    list.push({ label: 'Rests at', value: mm(restingHeightMm(props.bounds)) });
    list.push({
      label: 'Fits the interior',
      value: fitsInterior(props.bounds, props.interior) ? 'yes' : 'no',
    });
  }
  if (props.pocketSizeMm !== null) {
    list.push({
      label: 'Pocket size',
      value: `${props.pocketSizeMm.x.toFixed(2)} × ${props.pocketSizeMm.y.toFixed(2)} × ${props.pocketSizeMm.z.toFixed(2)} mm`,
    });
  }
  return list;
});
</script>

<template>
  <div>
    <div class="text-caption text-medium-emphasis mb-1">Selected model</div>
    <p v-if="props.model === null" class="text-body-2 text-medium-emphasis">
      Select a model in the list or in the 3D view to see its placement.
    </p>
    <dl v-else class="readout">
      <template v-for="row in rows" :key="row.label">
        <dt class="text-caption text-medium-emphasis">{{ row.label }}</dt>
        <dd class="text-body-2">{{ row.value }}</dd>
      </template>
    </dl>
  </div>
</template>

<style scoped>
.readout {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  margin: 0;
}

.readout dd {
  margin: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
