<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useApp } from '../../stores/app';
import { useBinDesigner } from '../../stores/binDesigner';
import { useBinQueue } from '../../stores/binQueue';
import { useToolTrace } from '../../stores/toolTrace';
import { useBinPreview } from '../../composables/useBinPreview';
import { generatePocketBin } from '../../workerClient';
import { maxPocketDepthMm } from '../../engine/trace/pocketBin';
import type { PocketBinParams } from '../../engine/trace/pocketBin';
import type { BinPockets, TracePaper, TracedBin } from '../../engine/plan/types';
import type { PaperCorners } from '../../engine/trace/types';
import { putPhoto } from '../../photoStore';
import { primitiveOutline } from '../../engine/trace/edit';
import BinViewport from '../BinViewport.vue';
import IconPicker from '../IconPicker.vue';
import MoreOptions from '../MoreOptions.vue';

/**
 * The right rail of the trace-and-layout workspace: the tool list with
 * per-tool editing controls, the bin footprint, finger-hole and basic-shape
 * entry points, the shared bin options, a collapsible 3D preview, and the
 * queue actions.
 */

const props = defineProps<{
  /** The queue entry being edited, or null when designing a new bin. */
  editingEntry: TracedBin | null;
  /** True when a tool can be re-traced (embedding ready or photo stored). */
  retraceAvailable: boolean;
}>();

const emit = defineEmits<{
  /** Asks the workspace to re-trace the tool from its stored clicks. */
  retrace: [toolId: string];
  saved: [];
  cancelled: [];
}>();

const app = useApp();
const designer = useBinDesigner();
const trace = useToolTrace();
const queue = useBinQueue();

const { labelText, labelIcon, heightUnits, notes } = storeToRefs(designer);
const { tools, selectedToolId, gridX, gridY, defaultDepthMm, fingerHoleMode, fingerHoleDiameterMm } =
  storeToRefs(trace);

const quantity = ref(1);

// Editing a traced queue row restores its quantity; a new design starts at 1.
watch(
  () => props.editingEntry?.id ?? null,
  () => {
    quantity.value = props.editingEntry !== null ? props.editingEntry.quantity : 1;
  },
  { immediate: true },
);

const selectedPlacement = computed(() =>
  selectedToolId.value !== null ? trace.placementOf(selectedToolId.value) ?? null : null,
);

const CLEARANCE_CHOICES = [0, 0.5, 1.5, 3, 4.5];

function setGridManually(axis: 'x' | 'y', value: number): void {
  const cells = Math.max(1, Math.floor(value));
  if (!Number.isFinite(cells)) return;
  trace.gridManual = true;
  if (axis === 'x') gridX.value = cells;
  else gridY.value = cells;
}

function applyDefaultDepth(value: number): void {
  if (!Number.isFinite(value) || value <= 0) return;
  defaultDepthMm.value = value;
  for (const placement of trace.placements) placement.pocketDepthMm = value;
}

function removeFingerHole(tool: { fingerHoles: unknown[] }, index: number): void {
  tool.fingerHoles.splice(index, 1);
}

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
  } catch (error) {
    primitiveError.value =
      error instanceof Error ? error.message : 'Adding the shape failed.';
  }
}

function toggleFingerHoleMode(): void {
  fingerHoleMode.value = !fingerHoleMode.value;
  // Holes are placed by clicking the layout canvas, so switch to it.
  if (fingerHoleMode.value) trace.workspaceMode = 'layout';
}

const depthLimit = computed(() => maxPocketDepthMm(heightUnits.value));

/** The pocket-bin parameters of the current design, as plain JSON. */
const pocketParams = computed<PocketBinParams>(() => ({
  gridX: trace.gridX,
  gridY: trace.gridY,
  heightUnits: designer.heightUnits,
  stackingLip: designer.stackingLip,
  magnetHoles: designer.magnetHoles,
  // The pocket generator rejects divider walls, so a pocket bin never has any.
  dividerCountX: 0,
  dividerCountY: 0,
  labelText: designer.labelText,
  labelText2: designer.labelText2,
  labelIcon: designer.labelIcon,
  tools: JSON.parse(JSON.stringify(trace.tools)),
  placements: JSON.parse(JSON.stringify(trace.placements)),
}));

// The preview generation always runs so the layout is validated; the heavy
// viewport itself mounts only once the preview card is expanded.
const { meshes, errorMessage } = useBinPreview(
  () => pocketParams.value,
  (params) => generatePocketBin(params as PocketBinParams),
);
const previewOpen = ref(false);

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
  if (trace.placements.length === 0) {
    addError.value = 'Trace and place at least one tool before adding the bin.';
    return;
  }
  if (errorMessage.value !== null) {
    addError.value = 'Fix the layout problem shown by the preview first.';
    return;
  }
  const params = pocketParams.value;
  const pockets: BinPockets = { tools: params.tools, placements: params.placements };
  const cleanNotes = notes.value.trim();
  const binParams = {
    gridX: params.gridX,
    gridY: params.gridY,
    heightUnits: params.heightUnits,
    stackingLip: params.stackingLip,
    magnetHoles: params.magnetHoles,
    dividerCountX: 0,
    dividerCountY: 0,
    labelText: params.labelText,
    labelText2: params.labelText2,
    labelIcon: params.labelIcon,
  };
  // The photo must be stored before the queue mutation: persisting the plan
  // sweeps stored photos no entry references, so the reference and the photo
  // have to land in that order.
  const source = await storeTraceSource();
  if (props.editingEntry !== null) {
    const { dividerCountX, dividerCountY, ...shared } = binParams;
    void dividerCountX;
    void dividerCountY;
    queue.update(props.editingEntry.id, {
      ...shared,
      pockets,
      ...source,
      quantity: quantity.value,
      notes: cleanNotes === '' ? undefined : cleanNotes,
    });
    app.stopEditing();
  } else {
    const id = queue.add(binParams, quantity.value, { kind: 'traced', pockets, ...source });
    if (cleanNotes !== '') queue.update(id, { notes: cleanNotes });
  }
  trace.reset();
  quantity.value = 1;
  emit('saved');
}

function cancelEdit(): void {
  app.stopEditing();
  trace.reset();
  quantity.value = 1;
  emit('cancelled');
}
</script>

<template>
  <div class="d-flex flex-column ga-3">
    <div>
      <div class="rail-head">Tools</div>
      <v-list v-if="tools.length > 0" density="compact" class="tool-list py-0">
        <template v-for="tool in tools" :key="tool.id">
          <v-list-item
            :active="tool.id === selectedToolId"
            @click="selectedToolId = tool.id === selectedToolId ? null : tool.id"
          >
            <v-list-item-title>{{ tool.name }}</v-list-item-title>
            <template #append>
              <v-btn
                v-if="tool.clicks.length > 0"
                icon
                size="x-small"
                variant="text"
                :disabled="!retraceAvailable"
                title="Re-trace this tool from its saved clicks."
                @click.stop="emit('retrace', tool.id)"
              >
                <v-icon icon="mdi-magic-staff" size="16" />
              </v-btn>
              <v-btn icon size="x-small" variant="text" @click.stop="trace.duplicateTool(tool.id)">
                <v-icon icon="mdi-content-copy" size="16" />
              </v-btn>
              <v-btn icon size="x-small" variant="text" color="error" @click.stop="trace.removeTool(tool.id)">
                <v-icon icon="mdi-close" size="16" />
              </v-btn>
            </template>
          </v-list-item>
          <div
            v-if="tool.id === selectedToolId && selectedPlacement !== null"
            class="tool-detail px-3 py-2"
          >
            <v-text-field
              v-model="tool.name"
              label="Tool name"
              density="compact"
              hide-details
              class="mb-2"
            />
            <div class="d-flex align-center flex-wrap ga-2">
              <v-text-field
                v-model.number="tool.rotationDeg"
                type="number"
                step="5"
                label="Rotation (degrees)"
                density="compact"
                hide-details
                class="small-field"
              />
              <v-select
                v-model="tool.offsetMm"
                :items="CLEARANCE_CHOICES"
                label="Clearance (mm)"
                density="compact"
                hide-details
                class="small-field"
              />
              <v-text-field
                v-model.number="selectedPlacement.pocketDepthMm"
                type="number"
                min="1"
                step="1"
                label="Depth (mm)"
                density="compact"
                hide-details
                class="small-field"
              />
            </div>
            <v-switch
              v-model="tool.mirrored"
              color="primary"
              density="compact"
              hide-details
              label="Mirrored"
            />
            <div v-if="tool.fingerHoles.length > 0" class="text-caption text-medium-emphasis mt-1">
              Finger holes
            </div>
            <div
              v-for="(hole, index) in tool.fingerHoles"
              :key="index"
              class="d-flex align-center ga-2"
            >
              <span class="text-caption">
                {{ hole.diameterMm }} mm at {{ hole.x.toFixed(0) }}, {{ hole.y.toFixed(0) }}
              </span>
              <v-btn icon size="x-small" variant="text" color="error" @click="removeFingerHole(tool, index)">
                <v-icon icon="mdi-close" size="14" />
              </v-btn>
            </div>
          </div>
        </template>
      </v-list>
      <p v-else class="text-body-2 text-medium-emphasis mb-0">
        Trace a tool on the canvas, or add a basic shape below.
      </p>
    </div>

    <div>
      <div class="rail-head">Footprint</div>
      <div class="d-flex align-center flex-wrap ga-2">
        <v-text-field
          :model-value="gridX"
          type="number"
          min="1"
          step="1"
          label="Width (grid units)"
          density="compact"
          hide-details
          class="small-field"
          @update:model-value="setGridManually('x', Number($event))"
        />
        <v-text-field
          :model-value="gridY"
          type="number"
          min="1"
          step="1"
          label="Depth (grid units)"
          density="compact"
          hide-details
          class="small-field"
          @update:model-value="setGridManually('y', Number($event))"
        />
        <v-text-field
          :model-value="defaultDepthMm"
          type="number"
          min="1"
          step="1"
          label="Pocket depth (mm)"
          density="compact"
          hide-details
          class="small-field"
          @update:model-value="applyDefaultDepth(Number($event))"
        />
      </div>
      <div class="d-flex align-center flex-wrap ga-2 mt-2">
        <v-btn
          :variant="fingerHoleMode ? 'flat' : 'outlined'"
          :color="fingerHoleMode ? 'primary' : undefined"
          size="small"
          prepend-icon="mdi-circle-outline"
          @click="toggleFingerHoleMode"
        >
          {{ fingerHoleMode ? 'Placing finger holes: click a tool' : 'Add finger hole' }}
        </v-btn>
        <v-text-field
          v-if="fingerHoleMode"
          v-model.number="fingerHoleDiameterMm"
          type="number"
          min="1"
          step="1"
          label="Hole diameter (mm)"
          density="compact"
          hide-details
          class="small-field"
        />
        <v-btn size="small" variant="outlined" prepend-icon="mdi-shape-outline" @click="primitiveDialog = true">
          Add basic shape
        </v-btn>
      </div>
    </div>

    <div>
      <div class="rail-head">Bin options</div>
      <v-text-field
        v-model.number="heightUnits"
        type="number"
        min="2"
        step="1"
        label="Height (units of 7 mm)"
        density="comfortable"
        :hint="`Pockets can be at most ${depthLimit} mm deep at this height.`"
        persistent-hint
      />
      <v-text-field
        v-model="labelText"
        label="Label"
        placeholder="What's inside?"
        density="comfortable"
        class="mt-2"
        hint="Embossed on the label shelf; long text shrinks to fit."
      />
      <div class="text-caption text-medium-emphasis mt-2 mb-1">Label icon</div>
      <IconPicker v-model="labelIcon" />
      <MoreOptions
        per-bin-fields
        hide-dividers
        :quantity="quantity"
        @update:quantity="quantity = $event"
      />
    </div>

    <v-card variant="outlined">
      <v-card-item class="preview-toggle" @click="previewOpen = !previewOpen">
        <div class="d-flex align-center justify-space-between">
          <span class="text-subtitle-2">3D preview</span>
          <v-icon :icon="previewOpen ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="20" />
        </div>
      </v-card-item>
      <v-expand-transition>
        <div v-show="previewOpen" class="preview-body">
          <BinViewport
            v-if="previewOpen"
            :mesh="meshes?.body ?? null"
            :label="meshes?.label ?? null"
          />
        </div>
      </v-expand-transition>
    </v-card>

    <div>
      <v-alert v-if="errorMessage" type="error" density="compact" class="mb-2">
        {{ errorMessage }}
      </v-alert>
      <v-alert v-if="addError" type="warning" density="compact" class="mb-2">
        {{ addError }}
      </v-alert>
      <v-alert v-if="photoNote" type="warning" density="compact" class="mb-2">
        {{ photoNote }}
      </v-alert>
      <div class="d-flex ga-2">
        <v-btn
          color="primary"
          variant="flat"
          size="large"
          class="flex-grow-1"
          @click="addToQueue"
        >
          {{ editingEntry !== null ? 'Save changes' : 'Add to queue' }}
        </v-btn>
        <v-btn
          v-if="editingEntry !== null"
          variant="outlined"
          size="large"
          @click="cancelEdit"
        >
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
        Editing "{{ editingEntry.labelText !== '' ? editingEntry.labelText : `${editingEntry.gridX} x ${editingEntry.gridY} x ${editingEntry.heightUnits}` }}"; saving updates the queue row.
      </v-alert>
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
.rail-head {
  font-weight: 700;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgba(var(--v-theme-on-surface), 0.6);
  margin-bottom: 6px;
}

.tool-list {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 8px;
}

.tool-detail {
  background: rgba(var(--v-theme-on-surface), 0.04);
}

.small-field {
  max-width: 160px;
}

.preview-toggle {
  cursor: pointer;
}

.preview-body {
  min-height: 280px;
}
</style>
