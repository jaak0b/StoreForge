<script setup lang="ts">
import { computed } from 'vue';
import { resolveLabelIcon } from '../labelIcons';

// Thumbnail: the footprint grid is rendered at most 6 x 6 cells; larger bins
// get a "+N" overlay stating how many cells are not shown.
const THUMB_CAP = 6;

const props = defineProps<{
  gridX: number;
  gridY: number;
  labelIcon: string | null;
}>();

const cells = computed(() => {
  const cols = Math.min(props.gridX, THUMB_CAP);
  const rows = Math.min(props.gridY, THUMB_CAP);
  return { cols, rows, hidden: props.gridX * props.gridY - cols * rows };
});

const icon = computed(() =>
  props.labelIcon !== null ? resolveLabelIcon(props.labelIcon) : null,
);
</script>

<template>
  <div
    class="footprint-thumb"
    :style="{
      gridTemplateColumns: `repeat(${cells.cols}, 1fr)`,
      gridTemplateRows: `repeat(${cells.rows}, 1fr)`,
    }"
  >
    <div v-for="cell in cells.cols * cells.rows" :key="cell" class="footprint-thumb__cell" />
    <div v-if="cells.hidden > 0" class="footprint-thumb__overlay text-caption">
      +{{ cells.hidden }}
    </div>
    <div v-else-if="icon !== null" class="footprint-thumb__overlay">
      <svg width="16" height="16" :viewBox="icon.viewBox.join(' ')" aria-hidden="true">
        <path :d="icon.path" fill="currentColor" fill-rule="evenodd" />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.footprint-thumb {
  position: relative;
  width: 48px;
  height: 48px;
  display: grid;
  gap: 1px;
  padding: 3px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 6px;
}

.footprint-thumb__cell {
  background: rgb(var(--v-theme-surface-variant));
  border-radius: 2px;
}

.footprint-thumb__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgb(var(--v-theme-on-surface));
}
</style>
