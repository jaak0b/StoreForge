<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  CAVITY_EDIT_RADIUS_MIN_MM,
  CAVITY_EDIT_RADIUS_MAX_MM,
  FLATTEN_HEIGHT_MIN_MM,
  FLATTEN_HEIGHT_MAX_MM,
} from '../../engine/carve/cavityEdits';
import type { CavityEdit } from '../../engine/plan/types';
import type { CavityTool } from '../../stores/cavityEditSession';

/**
 * The paint toolbar shared by every carved-interior bin editor: the add,
 * remove and flatten tool toggles, the brush radius field, the flatten cut
 * height field (shown only while the flatten tool is active), the undo and
 * redo buttons, and the shortcut help popover. Extracted from the cutout tab
 * so the traced tool bin shows the same controls rather than a second copy
 * (rule 10); a consumer with editor-specific actions (the cutout tab's clear
 * and hide-models buttons) passes them through the default slot, which sits
 * between the undo/redo buttons and the help popover.
 *
 * Bound to a cavity edit session: it reads the active tool and the brush and
 * flatten sizes and calls the session's setters. The brush radius and flatten
 * height are edited through local drafts committed on blur or Enter, then
 * resynced from the session in case it clamped the value.
 */

/** The session surface this toolbar drives, satisfied by both carve stores. */
interface CavityEditToolbarSession {
  activeTool: CavityTool | null;
  edits: CavityEdit[];
  redoStack: CavityEdit[];
  brushRadiusMm: number;
  flattenHeightMm: number;
  setActiveTool(tool: CavityTool | null): void;
  setBrushRadius(radiusMm: number): void;
  setFlattenHeight(heightMm: number): void;
  undoEdit(): void;
  redoEdit(): void;
}

/** One shortcut row in the help popover, action left, keys right. */
interface ShortcutRow {
  action: string;
  keys: string;
}

const props = defineProps<{
  session: CavityEditToolbarSession;
  /**
   * Editor-specific shortcut rows appended after the paint ones (the cutout
   * tab's "Hide models" row). The paint rows are owned here so every editor
   * lists them the same way.
   */
  extraShortcutRows?: ShortcutRow[];
}>();

/** The help popover's open state, owned by the parent so a viewport shortcut can toggle it. */
const shortcutHelpOpen = defineModel<boolean>('shortcutHelpOpen', { default: false });

/** The paint shortcuts every carve editor shares, in the order they read best. */
const baseShortcutRows: ShortcutRow[] = [
  { action: 'Paint add', keys: 'B' },
  { action: 'Paint remove', keys: 'E' },
  { action: 'Flatten', keys: 'S' },
  { action: 'Pointer mode', keys: 'V or Escape' },
  { action: 'Brush size', keys: '[ and ]' },
  { action: 'Undo', keys: 'Ctrl+Z' },
  { action: 'Redo', keys: 'Ctrl+Y' },
];

/** Draft value of the brush radius field, committed on blur or Enter. */
const brushRadiusDraft = ref(props.session.brushRadiusMm);
watch(
  () => props.session.brushRadiusMm,
  (radiusMm) => {
    brushRadiusDraft.value = radiusMm;
  },
);

/** Commits the brush radius draft, then resyncs in case the session clamped it. */
function onCommitBrushRadius(): void {
  props.session.setBrushRadius(brushRadiusDraft.value);
  brushRadiusDraft.value = props.session.brushRadiusMm;
}

/** Draft value of the flatten cut height field, committed on blur or Enter. */
const flattenHeightDraft = ref(props.session.flattenHeightMm);
watch(
  () => props.session.flattenHeightMm,
  (heightMm) => {
    flattenHeightDraft.value = heightMm;
  },
);

/** Commits the flatten cut height draft, then resyncs in case the session clamped it. */
function onCommitFlattenHeight(): void {
  props.session.setFlattenHeight(flattenHeightDraft.value);
  flattenHeightDraft.value = props.session.flattenHeightMm;
}

/** Toggles the named tool, turning it off when it is already active. */
function toggleTool(tool: CavityTool): void {
  props.session.setActiveTool(props.session.activeTool === tool ? null : tool);
}
</script>

<template>
  <div class="d-flex align-center flex-wrap ga-1">
    <v-btn
      icon
      size="small"
      variant="text"
      :color="session.activeTool === 'add' ? 'info' : undefined"
      @click="toggleTool('add')"
    >
      <v-icon icon="mdi-brush" size="20" />
      <v-tooltip activator="parent" location="bottom">Add material.</v-tooltip>
    </v-btn>
    <v-btn
      icon
      size="small"
      variant="text"
      :color="session.activeTool === 'remove' ? 'error' : undefined"
      @click="toggleTool('remove')"
    >
      <v-icon icon="mdi-eraser" size="20" />
      <v-tooltip activator="parent" location="bottom">Remove material.</v-tooltip>
    </v-btn>
    <v-btn
      icon
      size="small"
      variant="text"
      :color="session.activeTool === 'flatten' ? 'secondary' : undefined"
      @click="toggleTool('flatten')"
    >
      <v-icon icon="mdi-blur" size="20" />
      <v-tooltip activator="parent" location="bottom">Flatten to bin surface.</v-tooltip>
    </v-btn>
    <v-text-field
      v-model.number="brushRadiusDraft"
      type="number"
      label="Brush radius"
      suffix="mm"
      :min="CAVITY_EDIT_RADIUS_MIN_MM"
      :max="CAVITY_EDIT_RADIUS_MAX_MM"
      step="0.1"
      density="compact"
      hide-details
      style="max-width: 130px"
      class="ml-1"
      @blur="onCommitBrushRadius"
      @keydown.enter="onCommitBrushRadius"
    />
    <v-text-field
      v-if="session.activeTool === 'flatten'"
      v-model.number="flattenHeightDraft"
      type="number"
      label="Cut height"
      suffix="mm"
      :min="FLATTEN_HEIGHT_MIN_MM"
      :max="FLATTEN_HEIGHT_MAX_MM"
      step="0.5"
      density="compact"
      hide-details
      style="max-width: 130px"
      class="ml-1"
      @blur="onCommitFlattenHeight"
      @keydown.enter="onCommitFlattenHeight"
    />
    <v-btn
      icon
      size="small"
      variant="text"
      :disabled="session.edits.length === 0"
      @click="session.undoEdit()"
    >
      <v-icon icon="mdi-undo" size="20" />
      <v-tooltip activator="parent" location="bottom">Undo last edit.</v-tooltip>
    </v-btn>
    <v-btn
      icon
      size="small"
      variant="text"
      :disabled="session.redoStack.length === 0"
      @click="session.redoEdit()"
    >
      <v-icon icon="mdi-redo" size="20" />
      <v-tooltip activator="parent" location="bottom">Redo edit.</v-tooltip>
    </v-btn>
    <slot />
    <v-menu v-model="shortcutHelpOpen" location="top end" :close-on-content-click="false">
      <template #activator="{ props: menuProps }">
        <v-btn icon size="small" variant="text" v-bind="menuProps">
          <v-icon icon="mdi-help-circle-outline" size="20" />
          <v-tooltip activator="parent" location="bottom">Canvas shortcuts</v-tooltip>
        </v-btn>
      </template>
      <v-card min-width="280" class="pa-2">
        <div
          v-for="row in [...baseShortcutRows, ...(extraShortcutRows ?? [])]"
          :key="row.action"
          class="d-flex align-center justify-space-between ga-4 px-2 py-1 shortcut-row"
        >
          <span class="text-body-2">{{ row.action }}</span>
          <span class="text-caption text-medium-emphasis">{{ row.keys }}</span>
        </div>
      </v-card>
    </v-menu>
  </div>
</template>
