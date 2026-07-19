<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useApp } from '../../stores/app';
import { useBinDesigner } from '../../stores/binDesigner';
import { useBinQueue } from '../../stores/binQueue';
import { useToolTrace } from '../../stores/toolTrace';
import { useBinPreview } from '../../composables/useBinPreview';
import { generatePocketBin } from '../../workerClient';
import type { PocketBinParams } from '../../engine/trace/pocketBin';
import {
  insertOf,
  type BinPockets,
  type Product,
  type QueueEntry,
  type TracePaper,
  type TracedBin,
} from '../../engine/plan/types';
import type { PaperCorners } from '../../engine/trace/types';
import { putPhoto } from '../../photoStore';
import { primitiveOutline } from '../../engine/trace/edit';
import BinViewport from '../BinViewport.vue';
import LayoutCanvas from './LayoutCanvas.vue';
import LayoutToolbar from './LayoutToolbar.vue';
import AdvancedDrawer from './AdvancedDrawer.vue';

/**
 * The Layout mode of the trace-and-layout workspace: a full-bleed layout
 * canvas under a docked toolbar strip (selection controls on the left, the
 * global actions on the right), the queue action floating bottom right, and
 * a slide-in advanced drawer with the Trace and Bin tabs. The canvas swaps
 * in place to the 3D preview via the toolbar's 3D toggle.
 */

const props = defineProps<{
  /** The queue entry being edited (a traced product), or null when designing a new bin. */
  editingEntry: QueueEntry | null;
  /** True when a tool can be re-traced (embedding ready or photo stored). */
  retraceAvailable: boolean;
}>();

const emit = defineEmits<{
  /** Asks the workspace to re-trace the tool from its stored clicks. */
  retrace: [toolId: string];
  /** Asks the workspace to switch to Trace mode for another tool. */
  traceAnother: [];
  saved: [];
  cancelled: [];
}>();

const app = useApp();
const designer = useBinDesigner();
const trace = useToolTrace();
const queue = useBinQueue();

const { notes } = storeToRefs(designer);

/**
 * The product choice the trace flow starts a new design on: traced tool bins
 * hold pockets rather than a label, so they default to the plain bin. The
 * other tabs keep the shared designer default.
 */
const traceDefaultChoice = 'plainBin';

// The product choice is shared designer state. A new trace design starts on
// the trace default, while editing a queue entry keeps the choice rehydrated
// from that entry. Either way the trace tab cannot produce a standalone
// insert (pockets need a bin), so a leftover insert-only choice carried in
// from another tab falls back to the same default.
watch(
  [() => props.editingEntry?.id ?? null, () => designer.productChoice],
  ([entryId, choice], previous) => {
    const startingDesign = previous === undefined || previous[0] !== entryId;
    if (entryId === null && startingDesign) designer.productChoice = traceDefaultChoice;
    else if (choice === 'insert') designer.productChoice = traceDefaultChoice;
  },
  { immediate: true },
);
const { tools, fingerHoleMode, selectedToolId } = storeToRefs(trace);

const quantity = ref(1);

// Editing a traced queue row restores its quantity; a new design starts at 1.
watch(
  () => props.editingEntry?.id ?? null,
  () => {
    quantity.value = props.editingEntry !== null ? props.editingEntry.quantity : 1;
  },
  { immediate: true },
);

const drawerOpen = ref(false);
const show3d = ref(false);

// Selecting a tool while the 3D view is up returns to the 2D layout so the
// selection toolbar and the drag interaction are usable again.
watch(selectedToolId, (id) => {
  if (id !== null) show3d.value = false;
});

// Custom primitive dialog.
const primitiveDialog = ref(false);
const primitiveKind = ref<'circle' | 'rectangle'>('circle');
const primitiveDiameter = ref(20);
const primitiveWidth = ref(40);
const primitiveHeight = ref(20);
const primitiveCornerRadius = ref(2);
const primitiveError = ref<string | null>(null);

function addPrimitive(): void {
  primitiveError.value = null;
  try {
    const outline =
      primitiveKind.value === 'circle'
        ? primitiveOutline('circle', { diameterMm: primitiveDiameter.value })
        : primitiveOutline('rectangle', {
            widthMm: primitiveWidth.value,
            heightMm: primitiveHeight.value,
            cornerRadiusMm: primitiveCornerRadius.value,
          });
    trace.addTool(
      outline,
      primitiveKind.value === 'circle'
        ? `Circle ${primitiveDiameter.value} mm`
        : `Rectangle ${primitiveWidth.value} x ${primitiveHeight.value} mm`,
    );
    primitiveDialog.value = false;
    // The new shape lands on the layout canvas.
    trace.workspaceMode = 'layout';
    show3d.value = false;
  } catch (error) {
    primitiveError.value =
      error instanceof Error ? error.message : 'Adding the shape failed.';
  }
}

/**
 * The pocket-bin parameters of the current design, as plain JSON. The layout
 * model converts the world-frame layout to the pocket generator's
 * bin-centred coordinates (toBinLocal), so previews and saved entries share
 * one conversion.
 */
const pocketParams = computed<PocketBinParams>(() => {
  const local = trace.toBinLocal();
  const withInsert = designer.productChoice === 'binWithInsert';
  const content = {
    text: designer.labelText,
    text2: designer.labelText2,
    icon: designer.labelIcon,
  };
  const fusedContent = withInsert && designer.fused ? content : null;
  return {
    gridX: local.gridX,
    gridY: local.gridY,
    heightUnits: designer.heightUnits,
    magnetHoles: designer.magnetHoles,
    // The pocket generator rejects divider walls, so a pocket bin never has any.
    walls: [],
    // A fused bin has no insert channel; the label is raised on the solid
    // fused shelf the body builder puts in the channel's place.
    labelSlot: designer.productChoice !== 'plainBin' && fusedContent === null,
    insert: withInsert && !designer.fused ? content : null,
    fusedLabel: fusedContent,
    tools: JSON.parse(JSON.stringify(trace.tools)),
    placements: JSON.parse(JSON.stringify(local.placements)),
  };
});

// The preview generation always runs so the layout is validated (the
// worker's exact CSG containment check is the final authority over the
// layout model's bounding-box sizing); the heavy viewport itself mounts only
// while the 3D toggle is on. Its error alert is the single surface for
// layout validation problems.
const { meshes, errorMessage } = useBinPreview(
  () => pocketParams.value,
  (params) => generatePocketBin(params as PocketBinParams),
);

/**
 * Why the queue action is unavailable right now, or null when it can run.
 * The button is disabled with this as its tooltip, so an invalid layout can
 * never be queued.
 */
const submitBlocker = computed<string | null>(() => {
  if (trace.placements.length === 0) {
    return 'Trace and place at least one tool before adding the bin.';
  }
  if (errorMessage.value !== null) {
    return 'Fix the layout problem shown by the preview first.';
  }
  return null;
});

const addError = ref<string | null>(null);
/** Note about photo storage; survives the form reset. */
const photoNote = ref<string | null>(null);

/**
 * The trace-source fields to save with the entry: when a photo with a
 * confirmed sheet is loaded, its bytes go into the photo store (a fresh
 * upload under a new id, a resumed photo under its existing one). Without a
 * photo the fields stay untouched (an edit keeps the entry's stored ones).
 */
async function storeTraceSource(): Promise<{ traceSourceId?: string; paper?: TracePaper }> {
  if (trace.photoBlob === null || trace.calibration === null) return {};
  const traceSourceId = trace.sourceId ?? crypto.randomUUID();
  const paper: TracePaper = {
    corners: JSON.parse(JSON.stringify(trace.calibration.corners)) as PaperCorners,
    kind: trace.calibration.kind,
  };
  try {
    await putPhoto(traceSourceId, trace.photoBlob);
  } catch (error) {
    // The bin is still saved; without the stored photo it is layout-only
    // editable later, and the note says so.
    const detail = error instanceof Error ? error.message : String(error);
    photoNote.value = `Storing the trace photo failed (${detail}). The bin was saved, but its trace cannot be edited later without the photo.`;
    return {};
  }
  return { traceSourceId, paper };
}

async function addToQueue(): Promise<void> {
  addError.value = null;
  photoNote.value = null;
  // The button is disabled while a blocker stands; this guard backs it up.
  if (submitBlocker.value !== null) {
    addError.value = submitBlocker.value;
    return;
  }
  const params = pocketParams.value;
  const pockets: BinPockets = { tools: params.tools, placements: params.placements };
  const cleanNotes = notes.value.trim();
  // The photo must be stored before the queue mutation: persisting the plan
  // sweeps stored photos no entry references, so the reference and the photo
  // have to land in that order. During an edit without a newly loaded photo,
  // the entry's stored trace-source fields carry over.
  const source = await storeTraceSource();
  const editingProductBin =
    props.editingEntry !== null && props.editingEntry.product.kind !== 'insert'
      ? props.editingEntry.product.bin
      : null;
  const editingBin =
    editingProductBin !== null && editingProductBin.origin === 'traced'
      ? editingProductBin
      : null;
  const bin: TracedBin = {
    origin: 'traced',
    gridX: params.gridX,
    gridY: params.gridY,
    heightUnits: params.heightUnits,
    magnetHoles: params.magnetHoles,
    pockets,
  };
  const traceSourceId = source.traceSourceId ?? editingBin?.traceSourceId;
  const paper = source.paper ?? editingBin?.paper;
  if (traceSourceId !== undefined) bin.traceSourceId = traceSourceId;
  if (paper !== undefined) bin.paper = paper;
  let product: Product;
  if (params.fusedLabel != null) {
    product = { kind: 'binWithInsert', bin, insert: params.fusedLabel, fused: true };
  } else if (params.insert !== null) {
    product = { kind: 'binWithInsert', bin, insert: params.insert };
  } else {
    product = { kind: 'bin', bin, labelSlot: params.labelSlot };
  }
  if (props.editingEntry !== null) {
    queue.update(props.editingEntry.id, {
      product,
      quantity: quantity.value,
      notes: cleanNotes === '' ? undefined : cleanNotes,
    });
    app.stopEditing();
  } else {
    queue.add(product, quantity.value, cleanNotes);
  }
  trace.reset();
  quantity.value = 1;
  emit('saved');
}

/** Display title of the entry being edited. */
function editingTitle(entry: QueueEntry): string {
  const insert = insertOf(entry.product);
  if (insert !== null && insert.content.text !== '') return insert.content.text;
  if (entry.product.kind === 'insert') return `${entry.product.cells}u label insert`;
  const bin = entry.product.bin;
  return `${bin.gridX} x ${bin.gridY} x ${bin.heightUnits}`;
}

function cancelEdit(): void {
  app.stopEditing();
  trace.reset();
  quantity.value = 1;
  emit('cancelled');
}
</script>

<template>
  <div class="workspace">
    <div class="canvas-area">
      <LayoutToolbar
        v-model:show3d="show3d"
        v-model:drawer-open="drawerOpen"
        :retrace-available="retraceAvailable"
        @retrace="emit('retrace', $event)"
        @trace-another="emit('traceAnother')"
        @add-shape="primitiveDialog = true"
      />
      <div v-show="!show3d" class="canvas-wrap">
        <LayoutCanvas />
      </div>
      <div v-if="show3d" class="preview-body">
        <BinViewport :mesh="meshes?.body ?? null" :label="meshes?.label ?? null" />
      </div>

      <div class="canvas-hint text-caption text-medium-emphasis">
        <template v-if="tools.length === 0">
          Trace a tool with the plus button, or add a basic shape.
        </template>
        <template v-else-if="fingerHoleMode">
          Press anywhere in the bin to place a finger hole on the tool under
          the pointer, or on the selected tool. Drag before releasing to
          stretch the hole into a slot, and drag an endpoint handle of a
          placed slot to reshape it.
        </template>
        <template v-else>
          Drag each tool to its place; the bin outline follows the tools.
        </template>
      </div>

      <div class="queue-float">
        <v-alert v-if="errorMessage" type="error" density="compact" class="mb-2 float-alert">
          {{ errorMessage }}
        </v-alert>
        <v-alert v-if="addError" type="warning" density="compact" class="mb-2 float-alert">
          {{ addError }}
        </v-alert>
        <v-alert v-if="photoNote" type="warning" density="compact" class="mb-2 float-alert">
          {{ photoNote }}
        </v-alert>
        <div class="d-flex justify-end ga-2">
          <v-btn v-if="editingEntry !== null" variant="outlined" @click="cancelEdit">
            Cancel edit
          </v-btn>
          <v-tooltip :disabled="submitBlocker === null" :text="submitBlocker ?? ''" location="top">
            <template #activator="{ props: tooltipProps }">
              <div v-bind="tooltipProps" class="d-flex">
                <v-btn
                  color="primary"
                  variant="flat"
                  :disabled="submitBlocker !== null"
                  @click="addToQueue"
                >
                  {{ editingEntry !== null ? 'Save changes' : 'Add to queue' }}
                </v-btn>
              </div>
            </template>
          </v-tooltip>
        </div>
        <div v-if="editingEntry !== null" class="text-caption text-medium-emphasis text-right mt-1">
          Editing "{{ editingTitle(editingEntry) }}"; saving updates the queue row.
        </div>
      </div>
    </div>

    <div v-if="drawerOpen" class="drawer-pane">
      <AdvancedDrawer
        :retrace-available="retraceAvailable"
        :quantity="quantity"
        @update:quantity="quantity = $event"
        @retrace="emit('retrace', $event)"
      />
    </div>
  </div>

  <v-dialog v-model="primitiveDialog" max-width="360">
    <v-card>
      <v-card-title class="text-subtitle-1">Add a basic shape</v-card-title>
      <v-card-text>
        <v-btn-toggle v-model="primitiveKind" mandatory density="comfortable" variant="outlined" class="mb-3">
          <v-btn value="circle">Circle</v-btn>
          <v-btn value="rectangle">Rectangle</v-btn>
        </v-btn-toggle>
        <v-text-field
          v-if="primitiveKind === 'circle'"
          v-model.number="primitiveDiameter"
          type="number"
          min="1"
          label="Diameter (mm)"
          density="compact"
        />
        <template v-else>
          <v-text-field v-model.number="primitiveWidth" type="number" min="1" label="Width (mm)" density="compact" />
          <v-text-field v-model.number="primitiveHeight" type="number" min="1" label="Height (mm)" density="compact" />
          <v-text-field
            v-model.number="primitiveCornerRadius"
            type="number"
            min="0"
            label="Corner radius (mm)"
            density="compact"
          />
        </template>
        <v-alert v-if="primitiveError" type="error" density="compact">
          {{ primitiveError }}
        </v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="primitiveDialog = false">Cancel</v-btn>
        <v-btn color="primary" variant="flat" @click="addPrimitive">Add shape</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.workspace {
  display: flex;
  gap: 16px;
  align-items: stretch;
}

.canvas-area {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 420px;
}

.canvas-wrap {
  position: relative;
}

.preview-body {
  min-height: 420px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 8px;
}

.canvas-hint {
  position: absolute;
  left: 12px;
  bottom: 12px;
  max-width: 45%;
  z-index: 2;
  pointer-events: none;
}

.queue-float {
  position: absolute;
  right: 12px;
  bottom: 12px;
  max-width: min(420px, calc(100% - 24px));
  z-index: 4;
}

.float-alert {
  text-align: left;
}

.drawer-pane {
  flex: 0 0 340px;
  max-width: 340px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 8px;
  background: rgb(var(--v-theme-surface));
}

@media (max-width: 959px) {
  .workspace {
    flex-direction: column;
  }

  .drawer-pane {
    flex: 1 1 auto;
    max-width: none;
    width: 100%;
  }
}
</style>
