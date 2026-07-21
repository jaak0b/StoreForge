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
  type BaseplateBrim,
  CLIP_TOLERANCE_DEFAULT,
  CLIP_TOLERANCE_MAX,
  CLIP_TOLERANCE_MIN,
  MAGNET_DIAMETER_MAX,
  MAGNET_DIAMETER_MIN,
  MAGNET_HEIGHT_MAX,
  MAGNET_HEIGHT_MIN,
} from '../engine/baseplate/constants';
import { originOf, type QueueEntry } from '../engine/plan/types';
import { describeProduct } from '../engine/plan/rowDescriptor';
import { planDrawerFill, type DrawerFillPlate } from '../engine/baseplate/drawerFill';
import { baseplateCellCount, baseplateOuterMm } from '../engine/baseplate/generator';
import { validateProduct } from '../engine/plan/planFile';
import { PITCH } from '../engine/gridfinity/constants';
import type { BaseplateProduct } from '../engine/plan/types';
import BinViewport from './BinViewport.vue';
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

/** One planned plate's outer size in mm, for the readout and the SVG preview. */
function drawerFillOuterMm(plate: DrawerFillPlate): { widthMm: number; depthMm: number } {
  return baseplateOuterMm({ unitsX: plate.unitsX, unitsY: plate.unitsY, brim: plate.brim });
}

/** Whether two brims match on all four sides, for the readout's grouping. */
function sameBrim(a: BaseplateBrim, b: BaseplateBrim): boolean {
  return (
    a.leftMm === b.leftMm &&
    a.rightMm === b.rightMm &&
    a.frontMm === b.frontMm &&
    a.backMm === b.backMm
  );
}

/** One readout row: a run of identical planned plates and how many there are. */
interface DrawerFillGroup {
  count: number;
  plate: DrawerFillPlate;
}

/**
 * The planned plates grouped for the readout: plates with the same unit
 * counts and the same brim on all four sides collapse into one row with a
 * count. Presentation only; the plates queued are still the planner's own,
 * one product per plate.
 */
const drawerFillGroups = computed<DrawerFillGroup[]>(() => {
  const groups: DrawerFillGroup[] = [];
  for (const plate of drawerFillPlates.value) {
    const match = groups.find(
      (group) =>
        group.plate.unitsX === plate.unitsX &&
        group.plate.unitsY === plate.unitsY &&
        sameBrim(group.plate.brim, plate.brim),
    );
    if (match !== undefined) match.count += 1;
    else groups.push({ count: 1, plate });
  }
  return groups;
});

/**
 * One readout row's value: unit counts, outer mm (from baseplateOuterMm, the
 * single outer-size source) and the brimmed sides by name, omitting sides
 * with no brim; a plate with no brim at all gets no brim clause.
 */
function describeDrawerFillPlate(plate: DrawerFillPlate): string {
  const outer = drawerFillOuterMm(plate);
  const sides: string[] = [];
  if (plate.brim.leftMm > 0) sides.push(`left ${plate.brim.leftMm.toFixed(1)} mm`);
  if (plate.brim.rightMm > 0) sides.push(`right ${plate.brim.rightMm.toFixed(1)} mm`);
  if (plate.brim.frontMm > 0) sides.push(`front ${plate.brim.frontMm.toFixed(1)} mm`);
  if (plate.brim.backMm > 0) sides.push(`back ${plate.brim.backMm.toFixed(1)} mm`);
  const brimClause = sides.length > 0 ? `, brim ${sides.join(', ')}` : '';
  const outerMm = `${outer.widthMm.toFixed(1)}x${outer.depthMm.toFixed(1)} mm outer`;
  return `${plate.unitsX}x${plate.unitsY} units, ${outerMm}${brimClause}`;
}

const drawerFillQueueError = ref<string | null>(null);

/**
 * Queues one BaseplateProduct per planned plate, inheriting the tab's
 * current magnet, screw-hole and connectable settings for the plate's full
 * cells (the same settings store.product uses today, shared between both
 * modes); each plate's brim comes from the planner, never recomputed here.
 * All-or-nothing: every product is validated with the queue's own validator
 * first, and nothing is queued unless all of them pass, so a refused plate
 * never leaves the drawer partially filled.
 */
function addDrawerFillPlates(): void {
  drawerFillQueueError.value = null;
  const products: BaseplateProduct[] = drawerFillPlates.value.map((plate) => ({
    kind: 'baseplate',
    unitsX: plate.unitsX,
    unitsY: plate.unitsY,
    magnets: store.magnets,
    screwHoles: store.screwHoleMode === 'full',
    connectable: store.connectable,
    brim: plate.brim,
  }));
  for (const product of products) {
    const problem = validateProduct(product, 'A planned plate');
    if (problem !== null) {
      drawerFillQueueError.value = problem;
      return;
    }
  }
  for (const product of products) {
    const error = queue.add(product, 1);
    if (error !== null) {
      drawerFillQueueError.value = error;
      return;
    }
  }
}

/** One rectangle of the SVG drawer-fill preview: a full cell or a shaded brim strip. */
interface DrawerFillPreviewRect {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  brim: boolean;
}

/**
 * The full set of preview rectangles for every planned plate: one rect per
 * full cell (square, PITCH by PITCH) plus, for each brimmed side, one
 * shaded strip spanning that plate's full outer edge. Built directly from
 * the plan's own unitsX/unitsY/brim/column/row fields and PITCH, the same
 * inputs the plan itself is built from; no size is recomputed independently.
 */
const drawerFillPreviewRects = computed<DrawerFillPreviewRect[]>(() => {
  const rects: DrawerFillPreviewRect[] = [];
  // Running left/front-edge offsets per column/row, since columns and rows
  // can have different unit counts (the near-even split).
  const colOffsets: number[] = [];
  // The cell grid starts after the left brim, so every rectangle (including
  // the leftmost plate's brim strip) lands inside the 0-based viewBox.
  let runningX = drawerFillPlates.value[0]?.brim.leftMm ?? 0;
  for (const plate of drawerFillPlates.value) {
    if (plate.row === 0) {
      colOffsets[plate.column] = runningX;
      runningX += plate.unitsX * PITCH;
    }
  }
  const rowOffsets: number[] = [];
  let runningY = 0;
  for (const plate of drawerFillPlates.value) {
    if (plate.column === 0) {
      rowOffsets[plate.row] = runningY;
      runningY += plate.unitsY * PITCH;
    }
  }
  for (const plate of drawerFillPlates.value) {
    const originX = colOffsets[plate.column];
    const originY = rowOffsets[plate.row];
    for (let cx = 0; cx < plate.unitsX; cx++) {
      for (let cy = 0; cy < plate.unitsY; cy++) {
        rects.push({
          key: `cell-${plate.column}-${plate.row}-${cx}-${cy}`,
          x: originX + cx * PITCH,
          y: originY + cy * PITCH,
          width: PITCH,
          height: PITCH,
          brim: false,
        });
      }
    }
    if (plate.brim.leftMm > 0) {
      rects.push({
        key: `brim-left-${plate.column}-${plate.row}`,
        x: originX - plate.brim.leftMm,
        y: originY,
        width: plate.brim.leftMm,
        height: plate.unitsY * PITCH,
        brim: true,
      });
    }
    if (plate.brim.rightMm > 0) {
      rects.push({
        key: `brim-right-${plate.column}-${plate.row}`,
        x: originX + plate.unitsX * PITCH,
        y: originY,
        width: plate.brim.rightMm,
        height: plate.unitsY * PITCH,
        brim: true,
      });
    }
    if (plate.brim.backMm > 0) {
      rects.push({
        key: `brim-back-${plate.column}-${plate.row}`,
        x: originX,
        y: originY + plate.unitsY * PITCH,
        width: plate.unitsX * PITCH,
        height: plate.brim.backMm,
        brim: true,
      });
    }
  }
  // The plan's Y runs front to back (row 0 at the drawer opening), but the
  // top-down view shows the back wall at the top, so flip every rectangle's
  // Y within the drawer depth. The X mapping is unmirrored.
  const depthMm = drawerDepthMm.value ?? 0;
  return rects.map((rect) => ({ ...rect, y: depthMm - rect.y - rect.height }));
});

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
</script>

<template>
  <v-row>
    <v-col cols="12" md="6">
      <template v-if="clipEditingEntry === null">
      <v-btn-toggle
        v-if="editingEntry === null"
        v-model="sizeMode"
        mandatory
        density="comfortable"
        variant="outlined"
        class="mb-4"
      >
        <v-btn value="single">Single plate</v-btn>
        <v-btn value="fill">Fill a drawer</v-btn>
      </v-btn-toggle>

      <template v-if="sizeMode === 'single' || editingEntry !== null">
      <div class="text-caption text-medium-emphasis mb-1">
        Baseplate size (grid units of 42 mm) and brim (mm)
      </div>
      <div class="brim-box">
        <div class="brim-box__edge brim-box__edge--back">
          <span class="brim-box__caption">back</span>
          <v-text-field
            v-model.number="store.brimBackMm"
            type="number"
            min="0"
            step="0.1"
            density="compact"
            variant="outlined"
            hide-details
            class="brim-box__input"
          />
        </div>
        <div class="brim-box__middle">
          <div class="brim-box__edge brim-box__edge--left">
            <span class="brim-box__caption">left</span>
            <v-text-field
              v-model.number="store.brimLeftMm"
              type="number"
              min="0"
              step="0.1"
              density="compact"
              variant="outlined"
              hide-details
              class="brim-box__input"
            />
          </div>
          <div class="brim-box__plate brim-box__plate--editable">
            <v-text-field
              ref="widthField"
              v-model.number="store.unitsX"
              type="number"
              min="1"
              :max="BASEPLATE_UNITS_MAX"
              step="1"
              density="compact"
              variant="outlined"
              hide-details
              class="brim-box__unit-input"
            />
            <span class="text-medium-emphasis">x</span>
            <v-text-field
              v-model.number="store.unitsY"
              type="number"
              min="1"
              :max="BASEPLATE_UNITS_MAX"
              step="1"
              density="compact"
              variant="outlined"
              hide-details
              class="brim-box__unit-input"
            />
          </div>
          <div class="brim-box__edge brim-box__edge--right">
            <span class="brim-box__caption">right</span>
            <v-text-field
              v-model.number="store.brimRightMm"
              type="number"
              min="0"
              step="0.1"
              density="compact"
              variant="outlined"
              hide-details
              class="brim-box__input"
            />
          </div>
        </div>
        <div class="brim-box__edge brim-box__edge--front">
          <span class="brim-box__caption">front</span>
          <v-text-field
            v-model.number="store.brimFrontMm"
            type="number"
            min="0"
            step="0.1"
            density="compact"
            variant="outlined"
            hide-details
            class="brim-box__input"
          />
        </div>
      </div>
      <v-alert v-if="brimCapError" type="error" density="compact" class="mt-2">
        {{ brimCapError }}
      </v-alert>
      </template>

      <template v-else>
      <div class="text-caption text-medium-emphasis mb-1">
        Drawer size and build plate size (mm)
      </div>
      <p class="text-body-2 text-medium-emphasis mb-4">
        Enter the drawer's inside size and the printer's build plate size.
        The tool splits the drawer into as few baseplates as fit the build
        plate, and extends the plates against the back, left and right
        walls with a brimmed edge carrying partial sockets, so the plates
        cover the drawer wall to wall with no gap.
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
      <div class="d-flex align-center ga-2 mb-4">
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

      <template v-if="drawerFillPlates.length > 0">
        <div class="text-caption text-medium-emphasis mb-1">Plan</div>
        <table class="drawer-fill-readout mb-4">
          <tbody>
            <tr>
              <td>Plate count</td>
              <td>{{ drawerFillPlates.length }}</td>
            </tr>
            <tr v-for="(group, index) in drawerFillGroups" :key="index">
              <td>{{ group.count }} x plate</td>
              <td>{{ describeDrawerFillPlate(group.plate) }}</td>
            </tr>
          </tbody>
        </table>

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
            :class="rect.brim ? 'drawer-fill-brim' : 'drawer-fill-cell'"
          />
        </svg>
      </template>

      <div class="d-flex ga-2 mb-4">
        <v-btn
          color="primary"
          variant="outlined"
          :disabled="drawerFillPlates.length === 0"
          @click="addDrawerFillPlates"
        >
          Add plates to queue
        </v-btn>
      </div>
      <v-alert v-if="drawerFillQueueError" type="error" class="mb-4" density="compact">
        {{ drawerFillQueueError }}
      </v-alert>
      </template>

      <div class="text-caption text-medium-emphasis mb-1 mt-4">Base magnets</div>
      <v-btn-toggle
        v-model="store.magnetMode"
        mandatory
        density="comfortable"
        variant="outlined"
      >
        <v-btn value="none">None</v-btn>
        <v-btn value="full">Full</v-btn>
      </v-btn-toggle>
      <v-expand-transition>
        <div v-if="store.magnetMode === 'full'" class="mt-6">
          <v-slider
            v-model="store.magnetDiameterMm"
            :min="MAGNET_DIAMETER_MIN"
            :max="MAGNET_DIAMETER_MAX"
            step="0.1"
            thumb-label="always"
            label="Magnet diameter (mm)"
            hide-details
          >
            <template #append>
              <v-text-field
                v-model.number="store.magnetDiameterMm"
                type="number"
                :min="MAGNET_DIAMETER_MIN"
                :max="MAGNET_DIAMETER_MAX"
                step="0.1"
                density="compact"
                hide-details
                style="width: 90px"
              />
            </template>
          </v-slider>
          <v-slider
            v-model="store.magnetHeightMm"
            :min="MAGNET_HEIGHT_MIN"
            :max="MAGNET_HEIGHT_MAX"
            step="0.1"
            thumb-label="always"
            label="Magnet height (mm)"
            hide-details
            class="mt-4"
          >
            <template #append>
              <v-text-field
                v-model.number="store.magnetHeightMm"
                type="number"
                :min="MAGNET_HEIGHT_MIN"
                :max="MAGNET_HEIGHT_MAX"
                step="0.1"
                density="compact"
                hide-details
                style="width: 90px"
              />
            </template>
          </v-slider>
        </div>
      </v-expand-transition>

      <div class="text-caption text-medium-emphasis mb-1 mt-4">Screw holes</div>
      <v-btn-toggle
        v-model="store.screwHoleMode"
        mandatory
        density="comfortable"
        variant="outlined"
      >
        <v-btn value="none">None</v-btn>
        <v-btn value="full">Full</v-btn>
      </v-btn-toggle>

      <v-switch
        v-model="store.connectable"
        label="Connectable"
        color="primary"
        density="compact"
        hint="The plate's edges get the mating features a connection clip bridges."
        persistent-hint
        class="mt-2"
      />

      <template v-if="sizeMode === 'single' || editingEntry !== null">
      <v-text-field
        v-model.number="quantity"
        type="number"
        min="1"
        step="1"
        label="Quantity"
        density="comfortable"
        hide-details
        class="mt-4 quantity-field"
      />

      <MoreOptions v-model:open="moreOptionsOpen" :per-bin-fields="false" hide-bin-fields>
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
      </template>
      </template>

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
    </v-col>

    <v-col
      v-if="clipEditingEntry === null && (sizeMode === 'single' || editingEntry !== null)"
      cols="12"
      md="6"
    >
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
</template>

<style scoped>
.preview-card {
  min-height: 320px;
}
.drawer-fill-preview {
  width: 100%;
  max-height: 240px;
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
.drawer-fill-readout {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}
.drawer-fill-readout td {
  padding: 2px 8px 2px 0;
  vertical-align: top;
}
.brim-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
.brim-box__middle {
  display: flex;
  align-items: center;
  gap: 12px;
}
.brim-box__edge {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.brim-box__caption {
  font-size: 0.6875rem;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.brim-box__input {
  width: 72px;
  flex: none;
}
.brim-box__input :deep(input) {
  text-align: center;
}
.brim-box__plate {
  width: 96px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.brim-box__plate--editable {
  gap: 4px;
}
.brim-box__unit-input {
  width: 36px;
  flex: none;
}
.brim-box__unit-input :deep(input) {
  text-align: center;
  padding: 0;
}
.quantity-field {
  max-width: 140px;
}
</style>
