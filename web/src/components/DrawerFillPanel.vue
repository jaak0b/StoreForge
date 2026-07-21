<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useApp } from '../stores/app';
import { useBinQueue } from '../stores/binQueue';
import { useBaseplateDesigner, type HoleMode } from '../stores/baseplateDesigner';
import {
  MAGNET_DIAMETER_DEFAULT,
  MAGNET_HEIGHT_DEFAULT,
} from '../engine/baseplate/constants';
import {
  drawerFillLayoutRects,
  planDrawerFill,
  type DrawerFillInput,
  type DrawerFillPlate,
} from '../engine/baseplate/drawerFill';
import { groupDrawerFillPlanRows } from '../engine/baseplate/drawerFillPlan';
import { describeGroup, type GroupPlateStatus } from '../engine/plan/rowDescriptor';
import type { DrawerPlateOptions } from '../engine/plan/types';
import BaseplateOptionsFields from './BaseplateOptionsFields.vue';

/**
 * The one fill-a-drawer view, in create or edit mode. Create mode (groupId
 * null) plans plates from the entered drawer and build-plate sizes and queues
 * them as a new drawer group. Edit mode (a groupId) preloads the same layout
 * from a saved group and colors its top-down preview by each plate's print
 * status, adds name and progress, re-plans or re-stamps the
 * group through an apply action, offers delete, and re-queues a not-queued
 * plate on click. Both modes share the two-column layout, the top-down preview
 * (drawerFillLayoutRects, the single layout source) and the plan table
 * (groupDrawerFillPlanRows), so there is one view, never two parallel copies.
 */

const props = defineProps<{ groupId: string | null }>();

const app = useApp();
const queue = useBinQueue();
const store = useBaseplateDesigner();

/** Whether the panel is editing a saved group rather than composing a new one. */
const isEdit = computed(() => props.groupId !== null);

/** The group being edited, or null in create mode or once it is gone. */
const group = computed(() =>
  props.groupId === null ? null : queue.groupById(props.groupId),
);

// A deleted or missing group in edit mode closes the view rather than showing
// an empty panel.
watch(
  () => (isEdit.value ? group.value : undefined),
  (value) => {
    if (isEdit.value && (value === null || value === undefined)) app.closeDrawer();
  },
  { immediate: true },
);

// --- The four drawer and build-plate mm fields ----------------------------

const drawerWidthMm = ref<number | null>(null);
const drawerDepthMm = ref<number | null>(null);
const plateWidthMm = ref<number | null>(null);
const plateDepthMm = ref<number | null>(null);

// In edit mode the fields seed from the saved group; in create mode they start
// empty for the user to fill in.
watch(
  group,
  (value) => {
    if (value === null || value.payload.kind !== 'drawer') return;
    drawerWidthMm.value = value.payload.input.drawerWidthMm;
    drawerDepthMm.value = value.payload.input.drawerDepthMm;
    plateWidthMm.value = value.payload.input.plateWidthMm;
    plateDepthMm.value = value.payload.input.plateDepthMm;
  },
  { immediate: true },
);

// --- Options ---------------------------------------------------------------
// Edit mode keeps the group's options on local refs seeded from the group;
// create mode routes the same controls to the shared baseplate designer store,
// so a magnet or screw choice carries between the single-plate and fill forms
// exactly as before. The proxies below pick the source by mode, keeping one set
// of option controls in the markup.

const localMagnetMode = ref<HoleMode>('none');
const localMagnetDiameterMm = ref(MAGNET_DIAMETER_DEFAULT);
const localMagnetHeightMm = ref(MAGNET_HEIGHT_DEFAULT);
const localScrewHoleMode = ref<HoleMode>('none');
const localConnectable = ref(false);

watch(
  () => (group.value === null ? null : group.value.payload.options),
  (options) => {
    if (options === null || options === undefined) return;
    localMagnetMode.value = options.magnets !== null ? 'full' : 'none';
    localMagnetDiameterMm.value = options.magnets?.diameterMm ?? MAGNET_DIAMETER_DEFAULT;
    localMagnetHeightMm.value = options.magnets?.heightMm ?? MAGNET_HEIGHT_DEFAULT;
    localScrewHoleMode.value = options.screwHoles ? 'full' : 'none';
    localConnectable.value = options.connectable;
  },
  { immediate: true, deep: true },
);

const magnetMode = computed<HoleMode>({
  get: () => (isEdit.value ? localMagnetMode.value : store.magnetMode),
  set: (v) => {
    if (isEdit.value) localMagnetMode.value = v;
    else store.magnetMode = v;
  },
});
const magnetDiameterMm = computed<number>({
  get: () => (isEdit.value ? localMagnetDiameterMm.value : store.magnetDiameterMm),
  set: (v) => {
    if (isEdit.value) localMagnetDiameterMm.value = v;
    else store.magnetDiameterMm = v;
  },
});
const magnetHeightMm = computed<number>({
  get: () => (isEdit.value ? localMagnetHeightMm.value : store.magnetHeightMm),
  set: (v) => {
    if (isEdit.value) localMagnetHeightMm.value = v;
    else store.magnetHeightMm = v;
  },
});
const screwHoleMode = computed<HoleMode>({
  get: () => (isEdit.value ? localScrewHoleMode.value : store.screwHoleMode),
  set: (v) => {
    if (isEdit.value) localScrewHoleMode.value = v;
    else store.screwHoleMode = v;
  },
});
const connectable = computed<boolean>({
  get: () => (isEdit.value ? localConnectable.value : store.connectable),
  set: (v) => {
    if (isEdit.value) localConnectable.value = v;
    else store.connectable = v;
  },
});

/** The options the controls currently describe, collapsed like the designer's getter. */
const editedOptions = computed<DrawerPlateOptions>(() => ({
  magnets:
    magnetMode.value === 'full'
      ? { diameterMm: magnetDiameterMm.value, heightMm: magnetHeightMm.value }
      : null,
  screwHoles: screwHoleMode.value === 'full',
  connectable: connectable.value,
}));

// --- Live plan (create mode) ----------------------------------------------

/** The four fields as a plan input once all are filled in, else null. */
const filledInput = computed<DrawerFillInput | null>(() => {
  if (
    drawerWidthMm.value === null ||
    drawerDepthMm.value === null ||
    plateWidthMm.value === null ||
    plateDepthMm.value === null
  ) {
    return null;
  }
  return {
    drawerWidthMm: drawerWidthMm.value,
    drawerDepthMm: drawerDepthMm.value,
    plateWidthMm: plateWidthMm.value,
    plateDepthMm: plateDepthMm.value,
  };
});

/** The planner's outcome on the current fields, or null until all four are filled. */
const planOutcome = computed(() =>
  filledInput.value === null ? null : planDrawerFill(filledInput.value),
);

/** The freshly planned plates (create mode), empty while nothing planned or the plan errored. */
const plannedPlates = computed<DrawerFillPlate[]>(() => {
  const outcome = planOutcome.value;
  return outcome !== null && 'plates' in outcome ? outcome.plates : [];
});

/** The planner's error message, or null when there is none. */
const planError = computed<string | null>(() => {
  const outcome = planOutcome.value;
  return outcome !== null && 'error' in outcome ? outcome.error : null;
});

// --- Preview and plan table (shared) --------------------------------------

/** The plates the preview and plan table render: the saved group's in edit mode, the live plan in create mode. */
const previewPlates = computed<DrawerFillPlate[]>(() =>
  isEdit.value ? (group.value?.payload.plates ?? []) : plannedPlates.value,
);

/** The drawer width and depth the preview draws against. */
const previewWidthMm = computed(() =>
  isEdit.value ? (group.value?.payload.input.drawerWidthMm ?? 0) : (drawerWidthMm.value ?? 0),
);
const previewDepthMm = computed(() =>
  isEdit.value ? (group.value?.payload.input.drawerDepthMm ?? 0) : (drawerDepthMm.value ?? 0),
);

/** The top-down layout rectangles, from the single layout source. */
const layoutRects = computed(() =>
  drawerFillLayoutRects(previewPlates.value, previewDepthMm.value),
);

/** The plan-table rows (identical plates grouped with a count), from the shared helper. */
const planRows = computed(() => groupDrawerFillPlanRows(previewPlates.value));

// --- Edit-mode status coloring and requeue --------------------------------

/** The group's plates with their derived statuses and roll-up counts (edit mode). */
const descriptor = computed(() =>
  group.value === null ? null : describeGroup(group.value, queue.entries, queue.batches),
);

/** Status of each plate by its "column-row" key, so a rectangle can be colored by it. */
const statusByPosition = computed(() => {
  const map = new Map<string, GroupPlateStatus>();
  if (descriptor.value === null) return map;
  for (const item of descriptor.value.plates) {
    map.set(`${item.plate.column}-${item.plate.row}`, item.status);
  }
  return map;
});

/** Plate id of each plate by its "column-row" key, so a not-queued rectangle can be re-queued. */
const plateIdByPosition = computed(() => {
  const map = new Map<string, string>();
  if (group.value === null) return map;
  for (const plate of group.value.payload.plates) {
    map.set(`${plate.column}-${plate.row}`, plate.id);
  }
  return map;
});

/** The CSS status class of a layout rectangle, keyed by its plate position. */
function rectStatusClass(rect: { column: number; row: number }): string {
  const status = statusByPosition.value.get(`${rect.column}-${rect.row}`) ?? 'planned';
  return `status-${status}`;
}

/** Whether a rectangle's plate is not queued (planned), so a click re-queues it. */
function isPlanned(rect: { column: number; row: number }): boolean {
  return statusByPosition.value.get(`${rect.column}-${rect.row}`) === 'planned';
}

// The four status colors and their short legend labels, in print-cycle order.
const legend: { status: GroupPlateStatus; label: string }[] = [
  { status: 'done', label: 'Printed' },
  { status: 'printing', label: 'On a build plate' },
  { status: 'queued', label: 'Queued' },
  { status: 'planned', label: 'Not queued' },
];

// --- Create-mode hover linking --------------------------------------------

/** The plate positions currently highlighted by a hover (create mode preview and plan table). */
const highlightedPlates = ref<Set<string>>(new Set());

function plateKey(plate: { column: number; row: number }): string {
  return `${plate.column}-${plate.row}`;
}
function highlightRow(plates: DrawerFillPlate[]): void {
  highlightedPlates.value = new Set(plates.map(plateKey));
}
function highlightPlate(rect: { column: number; row: number }): void {
  highlightedPlates.value = new Set([plateKey(rect)]);
}
function clearHighlight(): void {
  highlightedPlates.value = new Set();
}
function rowHighlighted(plates: DrawerFillPlate[]): boolean {
  return plates.some((plate) => highlightedPlates.value.has(plateKey(plate)));
}

// --- Actions ---------------------------------------------------------------

const actionError = ref<string | null>(null);

/** Queues the planned plates as a new drawer group (create mode). */
function addPlates(): void {
  actionError.value = null;
  if (filledInput.value === null) return;
  const name = `Drawer ${filledInput.value.drawerWidthMm} × ${filledInput.value.drawerDepthMm} mm`;
  actionError.value = queue.addDrawerGroup(
    filledInput.value,
    editedOptions.value,
    plannedPlates.value,
    name,
  );
}

/** Re-queues the not-queued plate a rectangle belongs to (edit mode); a queued one does nothing. */
function requeue(rect: { column: number; row: number }): void {
  if (group.value === null || !isPlanned(rect)) return;
  const plateId = plateIdByPosition.value.get(`${rect.column}-${rect.row}`);
  if (plateId === undefined) return;
  actionError.value = queue.requeueGroupPlate(group.value.id, plateId);
}

/** Whether the edited mm fields differ from the group's saved inputs (edit mode). */
const inputDirty = computed(() => {
  if (group.value === null) return false;
  const input = group.value.payload.input;
  return (
    drawerWidthMm.value !== input.drawerWidthMm ||
    drawerDepthMm.value !== input.drawerDepthMm ||
    plateWidthMm.value !== input.plateWidthMm ||
    plateDepthMm.value !== input.plateDepthMm
  );
});

/** Whether the edited options differ from the group's saved options (edit mode). */
const optionsDirty = computed(() => {
  if (group.value === null) return false;
  const a = editedOptions.value;
  const b = group.value.payload.options;
  return (
    a.screwHoles !== b.screwHoles ||
    a.connectable !== b.connectable ||
    (a.magnets === null) !== (b.magnets === null) ||
    (a.magnets !== null &&
      b.magnets !== null &&
      (a.magnets.diameterMm !== b.magnets.diameterMm ||
        a.magnets.heightMm !== b.magnets.heightMm))
  );
});

/** Whether the apply action has anything to apply (edit mode). */
const editDirty = computed(() => inputDirty.value || optionsDirty.value);

const resizeConfirmOpen = ref(false);

/**
 * Applies the edited drawer (edit mode). A changed size re-plans the plates and
 * clears the printed record, so when any plate has already printed a confirm
 * dialog runs first; otherwise the change applies straight away.
 */
function applyEdit(): void {
  if (group.value === null) return;
  if (inputDirty.value && group.value.payload.donePlateIds.length > 0) {
    resizeConfirmOpen.value = true;
    return;
  }
  commitEdit();
}

/** Commits the edited size and options through the store, which decides structural vs re-stamp. */
function commitEdit(): void {
  if (group.value === null || filledInput.value === null) return;
  resizeConfirmOpen.value = false;
  actionError.value = queue.updateDrawerGroup(group.value.id, {
    input: filledInput.value,
    options: editedOptions.value,
  });
}

// --- Rename (edit mode) ----------------------------------------------------

const nameDraft = ref('');
watch(
  group,
  (value) => {
    if (value !== null) nameDraft.value = value.name;
  },
  { immediate: true },
);

/** Applies the edited group name when it is non-empty and changed. */
function applyName(): void {
  if (group.value === null) return;
  const name = nameDraft.value.trim();
  if (name === '' || name === group.value.name) return;
  queue.renameGroup(group.value.id, name);
}

// --- Delete (edit mode) ----------------------------------------------------

const deleteConfirmOpen = ref(false);

/** How many still-queued plate rows a delete would also remove. */
const queuedCount = computed(() => descriptor.value?.counts.queued ?? 0);

function deleteGroup(): void {
  if (group.value === null) return;
  deleteConfirmOpen.value = false;
  queue.removeGroup(group.value.id);
  app.closeDrawer();
}
</script>

<template>
  <div class="drawer-fill-panel">
    <!-- Edit mode: name, progress. -->
    <template v-if="isEdit && group !== null && descriptor !== null">
      <div class="d-flex align-center ga-2 mb-4" style="max-width: 520px">
        <v-text-field
          v-model="nameDraft"
          label="Drawer name"
          density="comfortable"
          hide-details
          @blur="applyName"
          @keydown.enter="applyName"
        />
        <v-btn
          variant="outlined"
          :disabled="nameDraft.trim() === '' || nameDraft.trim() === group.name"
          @click="applyName"
        >
          Rename
        </v-btn>
        <v-chip size="small" variant="tonal" color="primary">
          {{ descriptor.counts.done }} / {{ descriptor.counts.total }} printed
        </v-chip>
      </div>
    </template>

    <v-alert v-if="actionError" type="error" density="compact" class="mb-4">
      {{ actionError }}
    </v-alert>

    <!-- The two-column fill layout, shared by both modes. -->
    <div class="fill-layout">
      <div class="fill-inputs">
        <p v-if="!isEdit" class="text-body-2 text-medium-emphasis mb-3">
          Enter the drawer's inside size and your build plate size; the plates fill
          the drawer wall to wall.
        </p>
        <p v-else class="text-body-2 text-medium-emphasis mb-3">
          Changing the drawer or build plate size re-plans the plates.
        </p>
        <div class="d-flex align-center ga-2 mb-2">
          <v-text-field
            v-model.number="drawerWidthMm"
            type="number"
            min="0"
            label="Drawer width (mm)"
            density="comfortable"
            hide-details
          />
          <span class="text-medium-emphasis">x</span>
          <v-text-field
            v-model.number="drawerDepthMm"
            type="number"
            min="0"
            label="Drawer depth (mm)"
            density="comfortable"
            hide-details
          />
        </div>
        <div class="d-flex align-center ga-2 mb-2">
          <v-text-field
            v-model.number="plateWidthMm"
            type="number"
            min="0"
            label="Build plate width (mm)"
            density="comfortable"
            hide-details
          />
          <span class="text-medium-emphasis">x</span>
          <v-text-field
            v-model.number="plateDepthMm"
            type="number"
            min="0"
            label="Build plate depth (mm)"
            density="comfortable"
            hide-details
          />
        </div>
        <v-alert v-if="planError" type="error" density="compact" class="mb-4">
          {{ planError }}
        </v-alert>

        <BaseplateOptionsFields
          v-model:magnet-mode="magnetMode"
          v-model:magnet-diameter-mm="magnetDiameterMm"
          v-model:magnet-height-mm="magnetHeightMm"
          v-model:screw-hole-mode="screwHoleMode"
          v-model:connectable="connectable"
          class="mt-4"
        />
      </div>

      <div class="fill-preview">
        <template v-if="previewPlates.length > 0">
          <svg
            class="drawer-fill-preview mb-4"
            :viewBox="`0 0 ${previewWidthMm} ${previewDepthMm}`"
            preserveAspectRatio="xMidYMid meet"
          >
            <rect
              x="0"
              y="0"
              :width="previewWidthMm"
              :height="previewDepthMm"
              class="drawer-fill-outline"
            />
            <rect
              v-for="rect in layoutRects"
              :key="rect.key"
              :x="rect.x"
              :y="rect.y"
              :width="rect.width"
              :height="rect.height"
              :class="
                isEdit
                  ? [rectStatusClass(rect), { clickable: isPlanned(rect) }]
                  : [
                      rect.brim ? 'drawer-fill-brim' : 'drawer-fill-cell',
                      { highlighted: highlightedPlates.has(`${rect.column}-${rect.row}`) },
                    ]
              "
              @click="isEdit ? requeue(rect) : undefined"
              @mouseenter="isEdit ? undefined : highlightPlate(rect)"
              @mouseleave="isEdit ? undefined : clearHighlight()"
            >
              <title v-if="isEdit && isPlanned(rect)">Queue this plate again</title>
            </rect>
          </svg>

          <!-- The status legend, edit mode only. -->
          <div v-if="isEdit" class="d-flex flex-wrap ga-4 mb-2">
            <div v-for="item in legend" :key="item.status" class="d-flex align-center ga-2">
              <span class="legend-swatch" :class="`status-${item.status}`"></span>
              <span class="text-caption">{{ item.label }}</span>
            </div>
          </div>
          <p v-if="isEdit" class="text-caption text-medium-emphasis mb-3">
            Click a plate that is not queued to add it to the queue again.
          </p>

          <div class="plan-table-scroll">
          <table class="plan-table">
            <thead>
              <tr>
                <th>Count</th>
                <th>Units</th>
                <th>Outer size (mm)</th>
                <th>Brim (mm)</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, index) in planRows"
                :key="index"
                :class="{ highlighted: !isEdit && rowHighlighted(row.plates) }"
                @mouseenter="isEdit ? undefined : highlightRow(row.plates)"
                @mouseleave="isEdit ? undefined : clearHighlight()"
              >
                <td>{{ row.count }}×</td>
                <td>{{ row.unitsLabel }}</td>
                <td>{{ row.outerLabel }}</td>
                <td>{{ row.brimLabel }}</td>
              </tr>
            </tbody>
          </table>
          </div>
        </template>
        <div v-else class="fill-preview-empty text-body-2 text-medium-emphasis">
          Enter all four sizes to plan the plates.
        </div>
      </div>

      <div class="fill-actions">
        <v-btn
          v-if="!isEdit"
          color="primary"
          variant="flat"
          size="large"
          block
          :disabled="previewPlates.length === 0"
          @click="addPlates"
        >
          Add plates to queue
        </v-btn>
        <div v-else class="edit-actions">
          <v-btn
            color="primary"
            variant="flat"
            size="large"
            class="flex-grow-1"
            :disabled="!editDirty"
            @click="applyEdit"
          >
            Apply changes
          </v-btn>
          <v-btn variant="outlined" size="large" @click="app.closeDrawer()">
            Cancel edit
          </v-btn>
          <v-btn
            variant="outlined"
            color="error"
            class="delete-btn"
            aria-label="Delete drawer"
            @click="deleteConfirmOpen = true"
          >
            <v-icon icon="mdi-close" size="20" />
            <v-tooltip activator="parent" location="bottom">Delete drawer</v-tooltip>
          </v-btn>
        </div>
      </div>
    </div>

    <v-dialog v-model="resizeConfirmOpen" max-width="440">
      <v-card>
        <v-card-title>Re-plan the drawer?</v-card-title>
        <v-card-text>
          Re-planning replaces every plate, so the record of which plates have
          printed is cleared and the progress resets to zero.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="resizeConfirmOpen = false">Cancel</v-btn>
          <v-btn color="primary" variant="flat" @click="commitEdit">Re-plan</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="deleteConfirmOpen" max-width="440">
      <v-card>
        <v-card-title>Delete this drawer?</v-card-title>
        <v-card-text>
          Deleting the drawer also removes its {{ queuedCount }}
          {{ queuedCount === 1 ? 'queued plate row' : 'queued plate rows' }} from
          the queue. Plates already on a build plate are left alone.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="deleteConfirmOpen = false">Cancel</v-btn>
          <v-btn color="error" variant="flat" @click="deleteGroup">Delete</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
/*
 * The drawer-fill layout: inputs, preview and the action button wrap two per
 * row on a wide screen (inputs and preview side by side, the button under the
 * inputs), and stack in reading order on a narrow one, keeping the button last.
 */
.fill-layout {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
}
.fill-layout > * {
  flex: 1 1 100%;
  min-width: 0;
}
@media (min-width: 960px) {
  .fill-layout > * {
    flex: 1 1 calc(50% - 12px);
  }
}
.fill-inputs {
  order: 1;
}
.fill-preview {
  order: 2;
}
.fill-actions {
  order: 3;
}
.edit-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.edit-actions > * {
  flex: 1 1 auto;
}
.edit-actions > .delete-btn {
  flex: 0 0 auto;
  min-width: 48px;
  width: 48px;
  height: 44px;
  padding: 0;
}

.drawer-fill-preview {
  width: 100%;
  max-width: 100%;
  height: auto;
  max-height: 320px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.drawer-fill-outline {
  fill: none;
  stroke: rgba(var(--v-theme-on-surface), 0.4);
  stroke-width: 2;
}
.drawer-fill-cell {
  fill: rgba(var(--v-theme-primary), 0.25);
  stroke: rgba(var(--v-theme-primary), 0.6);
  stroke-width: 1;
}
.drawer-fill-brim {
  fill: rgba(var(--v-theme-warning), 0.25);
  stroke: rgba(var(--v-theme-warning), 0.6);
  stroke-width: 1;
}
.drawer-fill-cell.highlighted,
.drawer-fill-brim.highlighted {
  fill: rgba(var(--v-theme-primary), 0.55);
  stroke: rgb(var(--v-theme-primary));
  stroke-width: 2;
}
.drawer-fill-preview rect.clickable {
  cursor: pointer;
}

/* The four plate statuses, matching the legend swatches (edit mode). */
.status-done {
  fill: rgba(var(--v-theme-success), 0.35);
  stroke: rgb(var(--v-theme-success));
  stroke-width: 1;
}
.status-printing {
  fill: rgba(var(--v-theme-warning), 0.35);
  stroke: rgb(var(--v-theme-warning));
  stroke-width: 1;
}
.status-queued {
  fill: rgba(var(--v-theme-primary), 0.3);
  stroke: rgba(var(--v-theme-primary), 0.7);
  stroke-width: 1;
}
.status-planned {
  fill: rgba(var(--v-theme-on-surface), 0.05);
  stroke: rgba(var(--v-theme-on-surface), 0.35);
  stroke-width: 1;
  stroke-dasharray: 4 3;
}

.legend-swatch {
  display: inline-block;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.3);
}
.legend-swatch.status-done {
  background: rgba(var(--v-theme-success), 0.35);
  border-color: rgb(var(--v-theme-success));
}
.legend-swatch.status-printing {
  background: rgba(var(--v-theme-warning), 0.35);
  border-color: rgb(var(--v-theme-warning));
}
.legend-swatch.status-queued {
  background: rgba(var(--v-theme-primary), 0.3);
  border-color: rgba(var(--v-theme-primary), 0.7);
}
.legend-swatch.status-planned {
  background: rgba(var(--v-theme-on-surface), 0.05);
  border-style: dashed;
}

.fill-preview-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.2);
  border-radius: 8px;
  text-align: center;
  padding: 16px;
}

.plan-table-scroll {
  overflow-x: auto;
}
.plan-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}
.plan-table th {
  text-align: left;
  font-weight: 600;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  padding: 2px 8px 4px 0;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.12);
}
.plan-table td {
  padding: 3px 8px 3px 0;
  font-family: monospace;
}
.plan-table tbody tr {
  cursor: default;
}
.plan-table tbody tr.highlighted {
  background: rgba(var(--v-theme-primary), 0.12);
}
</style>
