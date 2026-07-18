<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { CLEARANCE_CHOICES, useToolTrace } from '../../stores/toolTrace';

/**
 * The floating pill toolbar of the layout canvas: shown while a tool is
 * selected, anchored near it (clamped to the canvas edges). Quick edits go
 * here (rotate nudges, mirror, clearance, depth, finger-hole mode); the
 * overflow menu carries duplicate, re-trace and delete. Precision editing
 * lives in the advanced drawer. All mutations go through the toolTrace
 * store's layout-model wrappers.
 */

const props = defineProps<{
  /** Anchor near the selected tool, as fractions of the canvas box. */
  anchor: { xFrac: number; yFrac: number } | null;
  /** True when a tool can be re-traced (embedding ready or photo stored). */
  retraceAvailable: boolean;
}>();

const emit = defineEmits<{
  /** Asks the workspace to re-trace the tool from its stored clicks. */
  retrace: [toolId: string];
}>();

const trace = useToolTrace();
const { selectedToolId, fingerHoleMode } = storeToRefs(trace);

const tool = computed(() =>
  selectedToolId.value !== null
    ? trace.tools.find((t) => t.id === selectedToolId.value) ?? null
    : null,
);

const placement = computed(() =>
  selectedToolId.value !== null
    ? trace.placementOf(selectedToolId.value) ?? null
    : null,
);

/** Clamped absolute position of the pill inside the canvas wrapper. */
const positionStyle = computed(() => {
  const anchor = props.anchor;
  if (anchor === null) return {};
  const left = Math.min(Math.max(anchor.xFrac * 100, 0), 100);
  const top = Math.min(Math.max(anchor.yFrac * 100, 0), 100);
  return {
    left: `clamp(210px, ${left}%, calc(100% - 210px))`,
    top: `clamp(8px, calc(${top}% - 56px), calc(100% - 56px))`,
  };
});

function nudgeRotation(deltaDeg: number): void {
  if (tool.value === null) return;
  trace.setToolTransform(tool.value.id, {
    rotationDeg: tool.value.rotationDeg + deltaDeg,
  });
}

function toggleMirror(): void {
  if (tool.value === null) return;
  trace.setToolTransform(tool.value.id, { mirrored: !tool.value.mirrored });
}

function setClearance(value: unknown): void {
  if (tool.value === null) return;
  trace.setToolTransform(tool.value.id, { offsetMm: Number(value) });
}

function setDepth(value: unknown): void {
  if (tool.value === null) return;
  const depth = Number(value);
  if (!Number.isFinite(depth) || depth <= 0) return;
  trace.setPocketDepth(tool.value.id, depth);
}

function removeTool(): void {
  if (tool.value === null) return;
  trace.removeTool(tool.value.id);
}
</script>

<template>
  <div
    v-if="tool !== null && placement !== null && anchor !== null"
    class="selection-toolbar"
    :style="positionStyle"
  >
    <v-btn icon size="small" variant="text" @click="nudgeRotation(-15)">
      <v-icon icon="mdi-rotate-left" size="20" />
      <v-tooltip activator="parent" location="top">Rotate 15 degrees counterclockwise</v-tooltip>
    </v-btn>
    <v-btn icon size="small" variant="text" @click="nudgeRotation(15)">
      <v-icon icon="mdi-rotate-right" size="20" />
      <v-tooltip activator="parent" location="top">Rotate 15 degrees clockwise</v-tooltip>
    </v-btn>
    <v-btn
      icon
      size="small"
      :variant="tool.mirrored ? 'tonal' : 'text'"
      :color="tool.mirrored ? 'primary' : undefined"
      @click="toggleMirror"
    >
      <v-icon icon="mdi-flip-horizontal" size="20" />
      <v-tooltip activator="parent" location="top">Mirror the tool</v-tooltip>
    </v-btn>
    <v-divider vertical class="mx-1 my-2" />
    <v-select
      :model-value="tool.offsetMm"
      :items="CLEARANCE_CHOICES"
      density="compact"
      hide-details
      variant="plain"
      class="toolbar-field clearance-field"
      @update:model-value="setClearance"
    >
      <template #prepend-inner>
        <span class="field-tag">Clearance</span>
      </template>
      <template #selection="{ item }">
        <span class="field-value">{{ item.value }} mm</span>
      </template>
    </v-select>
    <v-text-field
      :model-value="placement.pocketDepthMm"
      type="number"
      min="1"
      step="1"
      density="compact"
      hide-details
      variant="plain"
      class="toolbar-field depth-field"
      @update:model-value="setDepth"
    >
      <template #prepend-inner>
        <span class="field-tag">Depth mm</span>
      </template>
    </v-text-field>
    <v-divider vertical class="mx-1 my-2" />
    <v-btn
      icon
      size="small"
      :variant="fingerHoleMode ? 'tonal' : 'text'"
      :color="fingerHoleMode ? 'primary' : undefined"
      @click="fingerHoleMode = !fingerHoleMode"
    >
      <v-icon icon="mdi-circle-outline" size="20" />
      <v-tooltip activator="parent" location="top">
        {{
          fingerHoleMode
            ? 'Finger-hole mode is on: press on a tool to place a hole, drag to stretch it into a slot.'
            : 'Add a finger hole'
        }}
      </v-tooltip>
    </v-btn>
    <v-menu>
      <template #activator="{ props: menuProps }">
        <v-btn icon size="small" variant="text" v-bind="menuProps">
          <v-icon icon="mdi-dots-vertical" size="20" />
        </v-btn>
      </template>
      <v-list density="compact">
        <v-list-item
          prepend-icon="mdi-content-copy"
          title="Duplicate"
          @click="trace.duplicateTool(tool.id)"
        />
        <v-list-item
          v-if="tool.clicks.length > 0"
          prepend-icon="mdi-magic-staff"
          title="Re-trace"
          :disabled="!retraceAvailable"
          @click="emit('retrace', tool.id)"
        />
        <v-list-item
          prepend-icon="mdi-delete-outline"
          title="Delete"
          base-color="error"
          @click="removeTool"
        />
      </v-list>
    </v-menu>
  </div>
</template>

<style scoped>
.selection-toolbar {
  position: absolute;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px;
  border-radius: 24px;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgba(var(--v-theme-on-surface), 0.16);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  z-index: 3;
}

.toolbar-field {
  flex: 0 0 auto;
}

.toolbar-field :deep(.v-field__input) {
  padding-top: 4px;
  padding-bottom: 4px;
  min-height: 32px;
  font-size: 0.8125rem;
}

.clearance-field {
  width: 128px;
}

.depth-field {
  width: 110px;
}

.field-tag {
  font-size: 0.625rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgba(var(--v-theme-on-surface), 0.6);
  margin-right: 4px;
  align-self: center;
}

.field-value {
  white-space: nowrap;
}
</style>
