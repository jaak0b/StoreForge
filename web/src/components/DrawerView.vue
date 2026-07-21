<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useApp } from '../stores/app';
import { useBinQueue } from '../stores/binQueue';
import {
  MAGNET_DIAMETER_DEFAULT,
  MAGNET_HEIGHT_DEFAULT,
} from '../engine/baseplate/constants';
import { drawerFillLayoutRects } from '../engine/baseplate/drawerFill';
import { describeGroup, type GroupPlateStatus } from '../engine/plan/rowDescriptor';
import type { DrawerPlateOptions } from '../engine/plan/types';
import type { HoleMode } from '../stores/baseplateDesigner';
import BaseplateOptionsFields from './BaseplateOptionsFields.vue';

/**
 * The drawer group detail view: a top-down status layout of the drawer's
 * plates, roll-up counts, and the group's edit and delete actions. Opened from
 * a queue group header (app.viewingDrawerId) and closed back to the queue.
 * Reads its plate statuses from describeGroup, the single status source, and
 * its layout from drawerFillLayoutRects, the single top-down layout source.
 */

const app = useApp();
const queue = useBinQueue();

/** The group being viewed, or null once it is gone (a delete closes the view). */
const group = computed(() =>
  app.viewingDrawerId === null ? null : queue.groupById(app.viewingDrawerId),
);

// A deleted or missing group closes the view rather than showing an empty panel.
watch(
  group,
  (value) => {
    if (value === null) app.closeDrawer();
  },
  { immediate: true },
);

/** The group's plates with their derived statuses and roll-up counts. */
const descriptor = computed(() =>
  group.value === null
    ? null
    : describeGroup(group.value, queue.entries, queue.batches),
);

/** The drawer-fill inputs of the group, for the readout and the layout depth. */
const input = computed(() => (group.value === null ? null : group.value.payload.input));

/** The top-down layout rectangles, in drawer-local mm. */
const layoutRects = computed(() => {
  if (group.value === null || input.value === null) return [];
  return drawerFillLayoutRects(group.value.payload.plates, input.value.drawerDepthMm);
});

/** Status of each plate by its "column-row" key, so a rectangle can be colored by it. */
const statusByPosition = computed(() => {
  const map = new Map<string, GroupPlateStatus>();
  if (descriptor.value === null) return map;
  for (const item of descriptor.value.plates) {
    map.set(`${item.plate.column}-${item.plate.row}`, item.status);
  }
  return map;
});

/** Plate id of each plate by its "column-row" key, so a planned rectangle can be re-queued. */
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

/** Whether a rectangle's plate has no queue row or batch item, so it can be re-queued. */
function isPlanned(rect: { column: number; row: number }): boolean {
  return statusByPosition.value.get(`${rect.column}-${rect.row}`) === 'planned';
}

const actionError = ref<string | null>(null);

/** Re-queues the planned plate a rectangle belongs to; a non-planned rectangle does nothing. */
function requeue(rect: { column: number; row: number }): void {
  if (group.value === null || !isPlanned(rect)) return;
  const plateId = plateIdByPosition.value.get(`${rect.column}-${rect.row}`);
  if (plateId === undefined) return;
  actionError.value = queue.requeueGroupPlate(group.value.id, plateId);
}

// The four status colors and their short legend labels, in print-cycle order.
const legend: { status: GroupPlateStatus; label: string }[] = [
  { status: 'done', label: 'Printed' },
  { status: 'printing', label: 'On a build plate' },
  { status: 'queued', label: 'Queued' },
  { status: 'planned', label: 'Not queued' },
];

// --- Rename ---------------------------------------------------------------

const nameDraft = ref('');
watch(
  group,
  (value) => {
    if (value !== null) nameDraft.value = value.name;
  },
  { immediate: true },
);

/** Applies the edited group name, when it is non-empty and changed. */
function applyName(): void {
  if (group.value === null) return;
  const name = nameDraft.value.trim();
  if (name === '' || name === group.value.name) return;
  queue.renameGroup(group.value.id, name);
}

// --- Drawer size edit (structural) ---------------------------------------

const drawerWidthMm = ref(0);
const drawerDepthMm = ref(0);
const plateWidthMm = ref(0);
const plateDepthMm = ref(0);

watch(
  input,
  (value) => {
    if (value === null) return;
    drawerWidthMm.value = value.drawerWidthMm;
    drawerDepthMm.value = value.drawerDepthMm;
    plateWidthMm.value = value.plateWidthMm;
    plateDepthMm.value = value.plateDepthMm;
  },
  { immediate: true },
);

/** Whether the edited mm fields differ from the group's stored inputs. */
const inputDirty = computed(() => {
  if (input.value === null) return false;
  return (
    drawerWidthMm.value !== input.value.drawerWidthMm ||
    drawerDepthMm.value !== input.value.drawerDepthMm ||
    plateWidthMm.value !== input.value.plateWidthMm ||
    plateDepthMm.value !== input.value.plateDepthMm
  );
});

const resizeConfirmOpen = ref(false);

/**
 * Applies the edited drawer size. When plates have already printed, the store
 * clears that record on a re-plan, so a confirm dialog runs first; with none
 * printed it applies straight away.
 */
function applyInput(): void {
  if (group.value === null) return;
  if (group.value.payload.donePlateIds.length > 0) {
    resizeConfirmOpen.value = true;
    return;
  }
  commitInput();
}

/** Commits the drawer size change through the store's structural re-plan. */
function commitInput(): void {
  if (group.value === null) return;
  resizeConfirmOpen.value = false;
  actionError.value = queue.updateDrawerGroup(group.value.id, {
    input: {
      drawerWidthMm: drawerWidthMm.value,
      drawerDepthMm: drawerDepthMm.value,
      plateWidthMm: plateWidthMm.value,
      plateDepthMm: plateDepthMm.value,
    },
  });
}

// --- Options edit (non-structural) ---------------------------------------

const magnetMode = ref<HoleMode>('none');
const magnetDiameterMm = ref(MAGNET_DIAMETER_DEFAULT);
const magnetHeightMm = ref(MAGNET_HEIGHT_DEFAULT);
const screwHoleMode = ref<HoleMode>('none');
const connectable = ref(false);

watch(
  () => (group.value === null ? null : group.value.payload.options),
  (options) => {
    if (options === null || options === undefined) return;
    magnetMode.value = options.magnets !== null ? 'full' : 'none';
    magnetDiameterMm.value = options.magnets?.diameterMm ?? MAGNET_DIAMETER_DEFAULT;
    magnetHeightMm.value = options.magnets?.heightMm ?? MAGNET_HEIGHT_DEFAULT;
    screwHoleMode.value = options.screwHoles ? 'full' : 'none';
    connectable.value = options.connectable;
  },
  { immediate: true, deep: true },
);

/** The options the controls currently describe, collapsed like the designer's getter. */
const editedOptions = computed<DrawerPlateOptions>(() => ({
  magnets:
    magnetMode.value === 'full'
      ? { diameterMm: magnetDiameterMm.value, heightMm: magnetHeightMm.value }
      : null,
  screwHoles: screwHoleMode.value === 'full',
  connectable: connectable.value,
}));

/** Whether the edited options differ from the group's stored options. */
function optionsChanged(a: DrawerPlateOptions, b: DrawerPlateOptions): boolean {
  return (
    a.screwHoles !== b.screwHoles ||
    a.connectable !== b.connectable ||
    (a.magnets === null) !== (b.magnets === null) ||
    (a.magnets !== null &&
      b.magnets !== null &&
      (a.magnets.diameterMm !== b.magnets.diameterMm ||
        a.magnets.heightMm !== b.magnets.heightMm))
  );
}

// A change to the hardware controls re-stamps the group's queued plates at
// once (non-structural, no warning). The equality guard keeps the seeding
// watch above from triggering an update, so there is no feedback loop.
watch(
  editedOptions,
  (options) => {
    if (group.value === null) return;
    if (!optionsChanged(options, group.value.payload.options)) return;
    actionError.value = queue.updateDrawerGroup(group.value.id, { options });
  },
  { deep: true },
);

// --- Delete ---------------------------------------------------------------

const deleteConfirmOpen = ref(false);

/** How many still-queued plate rows a delete would also remove. */
const queuedCount = computed(() => descriptor.value?.counts.queued ?? 0);

function deleteGroup(): void {
  if (group.value === null) return;
  const id = group.value.id;
  deleteConfirmOpen.value = false;
  queue.removeGroup(id);
  app.closeDrawer();
}
</script>

<template>
  <div v-if="group !== null && descriptor !== null && input !== null">
    <div class="d-flex align-center mb-4">
      <v-btn variant="text" prepend-icon="mdi-arrow-left" @click="app.closeDrawer()">
        Back to queue
      </v-btn>
    </div>

    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <h2 class="text-h5">{{ group.name }}</h2>
      <v-chip size="small" variant="tonal" color="primary">
        {{ descriptor.counts.done }} / {{ descriptor.counts.total }} printed
      </v-chip>
    </div>

    <v-alert v-if="actionError" type="error" density="compact" class="mb-4">
      {{ actionError }}
    </v-alert>

    <v-row>
      <v-col cols="12" md="7">
        <svg
          class="drawer-layout mb-3"
          :viewBox="`0 0 ${input.drawerWidthMm} ${input.drawerDepthMm}`"
          preserveAspectRatio="xMidYMid meet"
        >
          <rect
            x="0"
            y="0"
            :width="input.drawerWidthMm"
            :height="input.drawerDepthMm"
            class="drawer-outline"
          />
          <rect
            v-for="rect in layoutRects"
            :key="rect.key"
            :x="rect.x"
            :y="rect.y"
            :width="rect.width"
            :height="rect.height"
            :class="[rectStatusClass(rect), { clickable: isPlanned(rect) }]"
            @click="requeue(rect)"
          >
            <title v-if="isPlanned(rect)">Queue this plate again</title>
          </rect>
        </svg>

        <div class="d-flex flex-wrap ga-4">
          <div v-for="item in legend" :key="item.status" class="d-flex align-center ga-2">
            <span class="legend-swatch" :class="`status-${item.status}`"></span>
            <span class="text-caption">{{ item.label }}</span>
          </div>
        </div>
        <p class="text-caption text-medium-emphasis mt-2">
          Click a plate that is not queued to add it to the queue again.
        </p>
      </v-col>

      <v-col cols="12" md="5">
        <table class="rollup">
          <tbody>
            <tr>
              <td>Drawer size</td>
              <td>{{ input.drawerWidthMm }} × {{ input.drawerDepthMm }} mm</td>
            </tr>
            <tr>
              <td>Build plate size</td>
              <td>{{ input.plateWidthMm }} × {{ input.plateDepthMm }} mm</td>
            </tr>
            <tr>
              <td>Plate count</td>
              <td>{{ descriptor.counts.total }}</td>
            </tr>
            <tr>
              <td>Printed</td>
              <td>{{ descriptor.counts.done }}</td>
            </tr>
            <tr>
              <td>Queued</td>
              <td>{{ descriptor.counts.queued }}</td>
            </tr>
            <tr>
              <td>On a build plate</td>
              <td>{{ descriptor.counts.printing }}</td>
            </tr>
            <tr>
              <td>Not queued</td>
              <td>{{ descriptor.counts.planned }}</td>
            </tr>
          </tbody>
        </table>
      </v-col>
    </v-row>

    <v-divider class="my-6" />

    <div class="text-subtitle-1 font-weight-bold mb-3">Drawer settings</div>

    <div class="d-flex align-center ga-2 mb-4" style="max-width: 480px">
      <v-text-field
        v-model="nameDraft"
        label="Drawer name"
        density="comfortable"
        hide-details
        @blur="applyName"
        @keydown.enter="applyName"
      />
      <v-btn variant="outlined" :disabled="nameDraft.trim() === '' || nameDraft.trim() === group.name" @click="applyName">
        Rename
      </v-btn>
    </div>

    <p class="text-body-2 text-medium-emphasis mb-2">
      Changing the drawer or build plate size re-plans the plates.
    </p>
    <div class="d-flex align-center ga-2 mb-2" style="max-width: 480px">
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
    <div class="d-flex align-center ga-2 mb-2" style="max-width: 480px">
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
    <v-btn variant="outlined" color="primary" :disabled="!inputDirty" class="mb-4" @click="applyInput">
      Apply drawer size
    </v-btn>

    <BaseplateOptionsFields
      v-model:magnet-mode="magnetMode"
      v-model:magnet-diameter-mm="magnetDiameterMm"
      v-model:magnet-height-mm="magnetHeightMm"
      v-model:screw-hole-mode="screwHoleMode"
      v-model:connectable="connectable"
      class="mb-4"
      style="max-width: 480px"
    />

    <v-divider class="my-6" />

    <v-btn variant="outlined" color="error" prepend-icon="mdi-delete-outline" @click="deleteConfirmOpen = true">
      Delete drawer
    </v-btn>

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
          <v-btn color="primary" variant="flat" @click="commitInput">Re-plan</v-btn>
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
.drawer-layout {
  width: 100%;
  max-height: 420px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.drawer-outline {
  fill: none;
  stroke: rgba(var(--v-theme-on-surface), 0.4);
  stroke-width: 2;
}
.drawer-layout rect.clickable {
  cursor: pointer;
}

/* The four plate statuses, matching the legend swatches. */
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

.rollup {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}
.rollup td {
  padding: 4px 8px 4px 0;
}
.rollup td:last-child {
  font-family: monospace;
  text-align: right;
}
</style>
