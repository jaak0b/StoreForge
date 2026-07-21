<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { useDisplay } from 'vuetify';
import { useApp } from '../stores/app';
import { useBaseplateDesigner } from '../stores/baseplateDesigner';
import { useBinQueue } from '../stores/binQueue';
import { useBinPreview } from '../composables/useBinPreview';
import { generateBaseplate } from '../workerClient';
import type { PartMeshes } from '../engine/gridfinity/types';
import type { BaseplateParams } from '../engine/baseplate/constants';
import {
  BASEPLATE_UNITS_MAX,
  CLIP_TOLERANCE_DEFAULT,
  CLIP_TOLERANCE_MAX,
  CLIP_TOLERANCE_MIN,
} from '../engine/baseplate/constants';
import { originOf, type QueueEntry } from '../engine/plan/types';
import { describeProduct } from '../engine/plan/rowDescriptor';
import {
  drawerFillLayoutRects,
  planDrawerFill,
  type DrawerFillPlate,
} from '../engine/baseplate/drawerFill';
import { groupDrawerFillPlanRows } from '../engine/baseplate/drawerFillPlan';
import { baseplateCellCount } from '../engine/baseplate/generator';
import { validateProduct } from '../engine/plan/planFile';
import BinViewport from './BinViewport.vue';
import BaseplateOptionsFields from './BaseplateOptionsFields.vue';
import MoreOptions from './MoreOptions.vue';

/**
 * The Baseplate tab of the add-bin card: the baseplate designer form with a
 * live preview beside it. Designs a new baseplate queue entry, or edits an
 * existing one when the app store carries an editing id.
 */

const app = useApp();
const store = useBaseplateDesigner();
const queue = useBinQueue();
const { smAndDown } = useDisplay();

// The 3D preview is heavy; on small screens it starts paused and loads on
// demand. Once loaded it stays loaded.
const previewLoaded = ref(!smAndDown.value);

/**
 * Largest cell count the preview regenerates for automatically. Above it the
 * preview waits for the Generate preview button, because a full-option plate
 * generates at roughly 42 ms per cell (measured on a 20 by 20 plate, about
 * 17 s total) and the worker cannot cancel work a keystroke has superseded.
 * A provisional UX pacing threshold pending owner review, not a geometry
 * constant.
 */
const LIVE_PREVIEW_MAX_CELLS = 25;

const quantity = ref(1);
const widthField = ref<{ focus: () => void } | null>(null);

// The single-plate form's More options disclosure; collapsed by default and
// component-local, unlike the bin tabs' shared store-persisted open state.
const moreOptionsOpen = ref(false);

// The connection clip's two fields. Component-local because neither is part
// of any baseplate design and neither needs to survive a tab switch.
const clipToleranceMm = ref(CLIP_TOLERANCE_DEFAULT);
const clipQuantity = ref(1);

/** Which size section the tab shows: the units X/Y form, or the drawer-fill form. Pure view state, never part of a queued product. */
const sizeMode = ref<'single' | 'fill'>('single');

// The drawer-fill form's four mm inputs. Component-local, like sizeMode:
// this tool composes queue entries from the tab's current magnet/screw/
// connectable settings, but keeps its own size fields since a drawer's and
// a build plate's mm size are not part of any single baseplate design.
const drawerWidthMm = ref<number | null>(null);
const drawerDepthMm = ref<number | null>(null);
const plateWidthMm = ref<number | null>(null);
const plateDepthMm = ref<number | null>(null);

/** The planner's outcome, or null until all four fields are filled in. */
const drawerFillResult = computed(() => {
  if (
    drawerWidthMm.value === null ||
    drawerDepthMm.value === null ||
    plateWidthMm.value === null ||
    plateDepthMm.value === null
  ) {
    return null;
  }
  return planDrawerFill({
    drawerWidthMm: drawerWidthMm.value,
    drawerDepthMm: drawerDepthMm.value,
    plateWidthMm: plateWidthMm.value,
    plateDepthMm: plateDepthMm.value,
  });
});

/** The planned plates, or an empty array while nothing has planned yet or the plan errored. */
const drawerFillPlates = computed<DrawerFillPlate[]>(() => {
  const result = drawerFillResult.value;
  return result !== null && 'plates' in result ? result.plates : [];
});

/** The planner's error message, or null when there is none to show. */
const drawerFillError = computed<string | null>(() => {
  const result = drawerFillResult.value;
  return result !== null && 'error' in result ? result.error : null;
});

/**
 * The planned plates grouped into plan-table rows (identical plates collapse
 * to one row with a count), from the shared presentation helper so the table
 * and its tests read the same rows and strings.
 */
const drawerFillPlanRows = computed(() => groupDrawerFillPlanRows(drawerFillPlates.value));

/**
 * The plate positions ("column-row") currently highlighted by a hover, shared
 * between the plan table and the SVG preview so a hovered table row lights its
 * plates and a hovered plate lights its table row. Empty when nothing hovers.
 */
const highlightedPlates = ref<Set<string>>(new Set());

/** The hover key of a plate, matching a layout rectangle's column and row. */
function plateKey(plate: { column: number; row: number }): string {
  return `${plate.column}-${plate.row}`;
}

/** Highlights every plate of a plan row (a table row hover). */
function highlightRow(plates: DrawerFillPlate[]): void {
  highlightedPlates.value = new Set(plates.map(plateKey));
}

/** Highlights one plate (an SVG rectangle hover). */
function highlightPlate(rect: { column: number; row: number }): void {
  highlightedPlates.value = new Set([plateKey(rect)]);
}

/** Clears the hover highlight. */
function clearHighlight(): void {
  highlightedPlates.value = new Set();
}

/** Whether a plan row has any plate in the current highlight, for the row's own highlight. */
function rowHighlighted(plates: DrawerFillPlate[]): boolean {
  return plates.some((plate) => highlightedPlates.value.has(plateKey(plate)));
}

const drawerFillQueueError = ref<string | null>(null);

/**
 * Queues the planned plates as one drawer group: the group carries the four mm
 * inputs, the tab's shared magnet, screw-hole and connectable options and the
 * planner's plates (each plate's brim is the planner's own), and one linked
 * baseplate row is added per plate. All-or-nothing lives in the store, which
 * validates the group and every plate first and leaves the plan untouched on
 * any refusal. A refusal is surfaced here.
 */
function addDrawerFillPlates(): void {
  drawerFillQueueError.value = null;
  if (
    drawerWidthMm.value === null ||
    drawerDepthMm.value === null ||
    plateWidthMm.value === null ||
    plateDepthMm.value === null
  ) {
    return;
  }
  const input = {
    drawerWidthMm: drawerWidthMm.value,
    drawerDepthMm: drawerDepthMm.value,
    plateWidthMm: plateWidthMm.value,
    plateDepthMm: plateDepthMm.value,
  };
  const options = {
    magnets: store.magnets,
    screwHoles: store.screwHoleMode === 'full',
    connectable: store.connectable,
  };
  const name = `Drawer ${drawerWidthMm.value} × ${drawerDepthMm.value} mm`;
  const error = queue.addDrawerGroup(input, options, drawerFillPlates.value, name);
  if (error !== null) drawerFillQueueError.value = error;
}

/**
 * The full set of preview rectangles for every planned plate, from the shared
 * drawer-fill layout function (the single source of the top-down layout, Y-flip
 * included), so the SVG preview and any other top-down view agree.
 */
const drawerFillPreviewRects = computed(() =>
  drawerFillLayoutRects(drawerFillPlates.value, drawerDepthMm.value ?? 0),
);

/**
 * Whether the current plate is small enough to regenerate on every change.
 * Counts the generated cells including the brim's partial cells
 * (baseplateCellCount), so a brimmed plate loaded for editing is gated by
 * the workload it actually generates.
 */
const livePreview = computed(() => baseplateCellCount(store.params) <= LIVE_PREVIEW_MAX_CELLS);

/**
 * The parameters the preview has been asked to generate. Follows the form
 * automatically while the plate is small; above the threshold it only moves
 * when the Generate preview button is pressed, so a large plate never queues
 * uncancellable worker runs on every keystroke.
 */
const requestedParams = shallowRef<BaseplateParams | null>(null);

watch(
  () => store.params,
  (params) => {
    if (livePreview.value) requestedParams.value = params;
  },
  { immediate: true },
);

/** True when the form has changed past what the preview last generated. */
const previewStale = computed(() => requestedParams.value !== store.params);

function generateNow(): void {
  requestedParams.value = store.params;
}

function generatePreview(params: BaseplateParams | null): Promise<PartMeshes | null> {
  // Nothing requested yet (a large plate before its first button press).
  if (params === null) return Promise.resolve(null);
  // A baseplate is one solid and has no second-filament part.
  return generateBaseplate(params).then((body) => ({ body, label: null }));
}

const { meshes, errorMessage } = useBinPreview(() => requestedParams.value, generatePreview);

function resetForm(): void {
  store.$reset();
  quantity.value = 1;
}

/** Loads the entry being edited into the form; null resets to a new design. */
function loadEditingEntry(entryId: string | null): void {
  if (entryId === null) {
    resetForm();
    return;
  }
  const entry = queue.entryById(entryId);
  if (entry === null || entry.product.kind !== 'baseplate') return;
  store.loadProduct(entry.product);
  store.notes = entry.notes ?? '';
  quantity.value = entry.quantity;
}

// The watch source is null unless the Baseplate tab owns the edit, so this
// tab never loads another tab's entry by construction. A clip row also routes
// to this tab but has its own parallel watcher below.
watch(
  () => (app.editingKind === 'baseplate' || app.editingKind === null ? app.editingEntryId : null),
  loadEditingEntry,
  { immediate: true },
);

// The parallel guard for a clip row: prefill the clip card from the stored
// product when a clip edit routes here.
watch(
  () => (app.editingKind === 'clip' ? app.editingEntryId : null),
  (entryId) => {
    if (entryId === null) return;
    const entry = queue.entryById(entryId);
    if (entry === null || entry.product.kind !== 'clip') return;
    clipToleranceMm.value = quantizeClipTolerance(entry.product.toleranceMm);
    clipQuantity.value = entry.quantity;
  },
  { immediate: true },
);

// Ctrl+N: reset to a new design and focus the first size field.
watch(
  () => app.focusAddSeq,
  () => {
    if (app.editingEntryId === null) resetForm();
    widthField.value?.focus();
  },
);

const editingEntry = computed<QueueEntry | null>(() => {
  if (app.editingKind !== 'baseplate' || app.editingEntryId === null) return null;
  const entry = queue.entryById(app.editingEntryId);
  return entry !== null && originOf(entry.product) === 'baseplate' ? entry : null;
});

// The queue's refusal of an invalid design, shown beside the save button.
const saveError = ref<string | null>(null);

/**
 * Live brim cap feedback: the same validateProduct check that blocks Add to
 * queue / Save changes at submit time, surfaced as soon as a brim side
 * reaches the cap so the user sees it while still editing. Filtered to the
 * brim's own message so an unrelated in-progress field (already constrained
 * by its own min/max) never shows here.
 */
const brimCapError = computed<string | null>(() => {
  const problem = validateProduct(store.product, 'This baseplate');
  return problem !== null && problem.includes('brim') ? problem : null;
});

function saveEntry(): void {
  const cleanNotes = store.notes.trim();
  const product = store.product;
  if (editingEntry.value !== null) {
    saveError.value = queue.update(editingEntry.value.id, {
      product,
      quantity: quantity.value,
      notes: cleanNotes === '' ? undefined : cleanNotes,
    });
    if (saveError.value !== null) return;
    app.stopEditing();
  } else {
    saveError.value = queue.add(product, quantity.value, cleanNotes);
    if (saveError.value !== null) return;
  }
  resetForm();
}

function cancelEdit(): void {
  app.stopEditing();
  resetForm();
}

/**
 * The clip entry being edited, when the app store routes a clip edit here. In
 * that mode the tab collapses to just the clip card.
 */
const clipEditingEntry = computed<QueueEntry | null>(() => {
  if (app.editingKind !== 'clip' || app.editingEntryId === null) return null;
  const entry = queue.entryById(app.editingEntryId);
  return entry !== null && entry.product.kind === 'clip' ? entry : null;
});

/**
 * Rounds a clip tolerance to two decimals: the 0.05 slider step quantizes
 * exactly at two decimals, so filenames and captions render clean instead of
 * carrying float artifacts like 0.30000000000000004. The single source of the
 * stored tolerance value; render sites never re-format it.
 */
function quantizeClipTolerance(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Queues clip rows, or saves the clip row being edited. Leaves the baseplate
 * form untouched, so clips can be added before or after the plate itself. The
 * two fields are clamped to their exported bounds on commit; the queue's own
 * validation stays the backstop.
 */
function addClips(): void {
  clipToleranceMm.value = quantizeClipTolerance(
    Math.min(CLIP_TOLERANCE_MAX, Math.max(CLIP_TOLERANCE_MIN, clipToleranceMm.value)),
  );
  clipQuantity.value = Math.max(1, Math.round(clipQuantity.value));
  const product = { kind: 'clip', toleranceMm: clipToleranceMm.value } as const;
  if (clipEditingEntry.value !== null) {
    clipSaveError.value = queue.update(clipEditingEntry.value.id, {
      product,
      quantity: clipQuantity.value,
    });
    if (clipSaveError.value !== null) return;
    app.stopEditing();
  } else {
    clipSaveError.value = queue.add(product, clipQuantity.value);
  }
}

// The queue's refusal of an invalid clip row, shown beside the clip button.
const clipSaveError = ref<string | null>(null);

function cancelClipEdit(): void {
  app.stopEditing();
  clipToleranceMm.value = CLIP_TOLERANCE_DEFAULT;
  clipQuantity.value = 1;
}

function editingTitle(entry: QueueEntry): string {
  return describeProduct(entry.product).title;
}

/** Whether the drawer-fill layout is showing (a new plate in fill mode, no clip edit). */
const fillMode = computed(
  () => clipEditingEntry.value === null && editingEntry.value === null && sizeMode.value === 'fill',
);
</script>

<template>
  <!-- The mode toggle switches the tab between designing one plate and filling
       a drawer; hidden while editing an existing plate. -->
  <v-btn-toggle
    v-if="clipEditingEntry === null && editingEntry === null"
    v-model="sizeMode"
    mandatory
    density="comfortable"
    variant="outlined"
    class="mb-4"
  >
    <v-btn value="single">Single plate</v-btn>
    <v-btn value="fill">Fill a drawer</v-btn>
  </v-btn-toggle>

  <!-- Fill a drawer: inputs and options on the left, the top-down preview and
       plan on the right, the queue button last. On a narrow screen the three
       stack in reading order, so the button stays last. -->
  <div v-if="fillMode" class="fill-layout">
    <div class="fill-inputs">
      <p class="text-body-2 text-medium-emphasis mb-3">
        Enter the drawer's inside size and your build plate size; the plates fill
        the drawer wall to wall.
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
      <v-alert v-if="drawerFillError" type="error" density="compact" class="mb-4">
        {{ drawerFillError }}
      </v-alert>

      <BaseplateOptionsFields
        v-model:magnet-mode="store.magnetMode"
        v-model:magnet-diameter-mm="store.magnetDiameterMm"
        v-model:magnet-height-mm="store.magnetHeightMm"
        v-model:screw-hole-mode="store.screwHoleMode"
        v-model:connectable="store.connectable"
        class="mt-4"
      />
    </div>

    <div class="fill-preview">
      <template v-if="drawerFillPlates.length > 0">
        <svg
          class="drawer-fill-preview mb-4"
          :viewBox="`0 0 ${drawerWidthMm} ${drawerDepthMm}`"
          preserveAspectRatio="xMidYMid meet"
        >
          <rect
            x="0"
            y="0"
            :width="drawerWidthMm ?? 0"
            :height="drawerDepthMm ?? 0"
            class="drawer-fill-outline"
          />
          <rect
            v-for="rect in drawerFillPreviewRects"
            :key="rect.key"
            :x="rect.x"
            :y="rect.y"
            :width="rect.width"
            :height="rect.height"
            :class="[
              rect.brim ? 'drawer-fill-brim' : 'drawer-fill-cell',
              { highlighted: highlightedPlates.has(`${rect.column}-${rect.row}`) },
            ]"
            @mouseenter="highlightPlate(rect)"
            @mouseleave="clearHighlight"
          />
        </svg>

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
              v-for="(row, index) in drawerFillPlanRows"
              :key="index"
              :class="{ highlighted: rowHighlighted(row.plates) }"
              @mouseenter="highlightRow(row.plates)"
              @mouseleave="clearHighlight"
            >
              <td>{{ row.count }}×</td>
              <td>{{ row.unitsLabel }}</td>
              <td>{{ row.outerLabel }}</td>
              <td>{{ row.brimLabel }}</td>
            </tr>
          </tbody>
        </table>
      </template>
      <div v-else class="fill-preview-empty text-body-2 text-medium-emphasis">
        Enter all four sizes to plan the plates.
      </div>
    </div>

    <div class="fill-actions">
      <v-btn
        color="primary"
        variant="flat"
        size="large"
        block
        :disabled="drawerFillPlates.length === 0"
        @click="addDrawerFillPlates"
      >
        Add plates to queue
      </v-btn>
      <v-alert v-if="drawerFillQueueError" type="error" class="mt-4" density="compact">
        {{ drawerFillQueueError }}
      </v-alert>
    </div>
  </div>

  <!-- Single plate, or editing an existing plate: the form beside the 3D preview. -->
  <v-row v-else-if="clipEditingEntry === null">
    <v-col cols="12" md="6">
      <div class="text-caption text-medium-emphasis mb-1">
        Baseplate size (grid units of 42 mm)
      </div>
      <div class="d-flex align-center ga-2 mb-2">
        <v-text-field
          ref="widthField"
          v-model.number="store.unitsX"
          type="number"
          min="1"
          :max="BASEPLATE_UNITS_MAX"
          step="1"
          label="Width"
          density="comfortable"
          hide-details
        />
        <span class="text-medium-emphasis">x</span>
        <v-text-field
          v-model.number="store.unitsY"
          type="number"
          min="1"
          :max="BASEPLATE_UNITS_MAX"
          step="1"
          label="Depth"
          density="comfortable"
          hide-details
        />
      </div>
      <v-alert v-if="brimCapError" type="error" density="compact" class="mt-2">
        {{ brimCapError }}
      </v-alert>

      <BaseplateOptionsFields
        v-model:magnet-mode="store.magnetMode"
        v-model:magnet-diameter-mm="store.magnetDiameterMm"
        v-model:magnet-height-mm="store.magnetHeightMm"
        v-model:screw-hole-mode="store.screwHoleMode"
        v-model:connectable="store.connectable"
        class="mt-4"
      />

      <MoreOptions
        v-model:open="moreOptionsOpen"
        per-bin-fields
        hide-bin-fields
        :quantity="quantity"
        @update:quantity="quantity = $event"
      >
        <template #fields>
          <div class="brim-fields-row">
            <v-row dense>
              <v-col cols="6">
                <v-text-field
                  v-model.number="store.brimLeftMm"
                  type="number"
                  min="0"
                  step="0.1"
                  label="Brim left (mm)"
                  density="comfortable"
                  hide-details
                />
              </v-col>
              <v-col cols="6">
                <v-text-field
                  v-model.number="store.brimRightMm"
                  type="number"
                  min="0"
                  step="0.1"
                  label="Brim right (mm)"
                  density="comfortable"
                  hide-details
                />
              </v-col>
              <v-col cols="6">
                <v-text-field
                  v-model.number="store.brimFrontMm"
                  type="number"
                  min="0"
                  step="0.1"
                  label="Brim front (mm)"
                  density="comfortable"
                  hide-details
                />
              </v-col>
              <v-col cols="6">
                <v-text-field
                  v-model.number="store.brimBackMm"
                  type="number"
                  min="0"
                  step="0.1"
                  label="Brim back (mm)"
                  density="comfortable"
                  hide-details
                />
              </v-col>
            </v-row>
          </div>
        </template>
        <template #after>
          <v-textarea
            v-model="store.notes"
            label="Notes"
            rows="2"
            auto-grow
            density="comfortable"
            hide-details
            class="mt-3"
          />
        </template>
      </MoreOptions>

      <v-alert v-if="errorMessage" type="error" class="mt-4" density="compact">
        {{ errorMessage }}
      </v-alert>
      <v-alert v-if="saveError" type="error" class="mt-4" density="compact">
        {{ saveError }}
      </v-alert>

      <div class="d-flex ga-2 mt-4">
        <v-btn color="primary" variant="flat" size="large" class="flex-grow-1" @click="saveEntry">
          {{ editingEntry !== null ? 'Save changes' : 'Add to queue' }}
        </v-btn>
        <v-btn v-if="editingEntry !== null" variant="outlined" size="large" @click="cancelEdit">
          Cancel edit
        </v-btn>
      </div>
      <v-alert
        v-if="editingEntry !== null"
        type="info"
        variant="tonal"
        density="compact"
        class="mt-2"
      >
        Editing "{{ editingTitle(editingEntry) }}"; saving updates the queue row.
      </v-alert>
    </v-col>

    <v-col cols="12" md="6">
      <v-card variant="outlined" class="preview-card">
        <template v-if="!previewLoaded">
          <div class="d-flex flex-column align-center justify-center text-center fill-height pa-8">
            <v-icon icon="mdi-cube-outline" size="64" class="mb-4 text-medium-emphasis" />
            <p class="text-body-2 text-medium-emphasis mb-4">
              The 3D preview is paused on small screens.
            </p>
            <v-btn color="primary" variant="tonal" @click="previewLoaded = true">
              Load preview
            </v-btn>
          </div>
        </template>
        <template v-else-if="!livePreview && previewStale">
          <div class="d-flex flex-column align-center justify-center text-center fill-height pa-8">
            <v-icon icon="mdi-cube-outline" size="64" class="mb-4 text-medium-emphasis" />
            <p class="text-body-2 text-medium-emphasis mb-4">
              The preview of a plate this large takes a while to generate, so it
              waits until you ask for it.
            </p>
            <v-btn color="primary" variant="tonal" @click="generateNow">
              Generate preview
            </v-btn>
          </div>
        </template>
        <BinViewport v-else :mesh="meshes?.body ?? null" :label="null" />
      </v-card>
    </v-col>
  </v-row>

  <!-- The connection clip card: shown while designing a connectable plate, or
       alone when a clip row routes here for editing. -->
  <v-card
    v-if="(editingEntry === null && store.connectable) || clipEditingEntry !== null"
    variant="tonal"
    class="mt-4"
    density="compact"
  >
    <v-card-item>
      <v-card-title>Connection clips</v-card-title>
    </v-card-item>
    <v-card-text>
      <p class="text-body-2 text-medium-emphasis mb-4">
        A connection clip bridges two connectable baseplates. It prints as
        its own part, so it is queued as a separate row.
      </p>
      <v-slider
        v-model="clipToleranceMm"
        :min="CLIP_TOLERANCE_MIN"
        :max="CLIP_TOLERANCE_MAX"
        step="0.05"
        thumb-label="always"
        label="Clip tolerance (mm)"
        hint="The clearance is added to the clip only, so a clip printed with a larger tolerance still fits a plate you have already printed. Raise it when the clip is too tight to push into the joint."
        persistent-hint
        class="mt-4"
      >
        <template #append>
          <v-text-field
            v-model.number="clipToleranceMm"
            type="number"
            :min="CLIP_TOLERANCE_MIN"
            :max="CLIP_TOLERANCE_MAX"
            step="0.05"
            density="compact"
            hide-details
            style="width: 90px"
          />
        </template>
      </v-slider>
      <div class="d-flex align-center ga-2 mt-4">
        <v-text-field
          v-model.number="clipQuantity"
          type="number"
          min="1"
          step="1"
          label="Quantity"
          density="comfortable"
          hide-details
          style="max-width: 140px"
        />
        <v-btn variant="outlined" @click="addClips">
          {{ clipEditingEntry !== null ? 'Save changes' : 'Add clips to queue' }}
        </v-btn>
        <v-btn v-if="clipEditingEntry !== null" variant="outlined" @click="cancelClipEdit">
          Cancel edit
        </v-btn>
      </div>
      <v-alert v-if="clipSaveError" type="error" class="mt-4" density="compact">
        {{ clipSaveError }}
      </v-alert>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.preview-card {
  min-height: 320px;
}
.brim-fields-row {
  grid-column: 1 / -1;
  order: -1;
}

/*
 * The drawer-fill layout: inputs, preview and the queue button wrap two per
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

.drawer-fill-preview {
  width: 100%;
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
