<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useDisplay } from 'vuetify';
import { useApp } from '../../stores/app';
import { useBinDesigner } from '../../stores/binDesigner';
import { useBinQueue } from '../../stores/binQueue';
import { useToolTrace } from '../../stores/toolTrace';
import { useBinPreview } from '../../composables/useBinPreview';
import { generatePocketBin } from '../../workerClient';
import { maxPocketDepthMm } from '../../engine/trace/pocketBin';
import type { PocketBinParams } from '../../engine/trace/pocketBin';
import type { BinPockets } from '../../engine/plan/types';
import BinViewport from '../BinViewport.vue';
import IconPicker from '../IconPicker.vue';
import MoreOptions from '../MoreOptions.vue';
import PhotoStep from './PhotoStep.vue';
import TraceStep from './TraceStep.vue';
import LayoutStep from './LayoutStep.vue';

/**
 * The Tool trace tab of the add-bin card: photograph tools on a reference
 * sheet, trace them by clicking, lay the pockets out in a bin, and queue the
 * result. The trace state lives in the toolTrace store so it survives tab
 * switches; the photo itself stays in the vision worker.
 */

const app = useApp();
const designer = useBinDesigner();
const trace = useToolTrace();
const queue = useBinQueue();
const { smAndDown } = useDisplay();

const { labelText, labelIcon, heightUnits, notes } = storeToRefs(designer);
const { rectifiedPreview, embedReady, encodeMs, tools } = storeToRefs(trace);

const quantity = ref(1);
const previewLoaded = ref(!smAndDown.value);

/** The queue entry being edited on this tab, or null when designing a new bin. */
const editingEntry = computed(() => {
  if (app.editingKind !== 'traced' || app.editingEntryId === null) return null;
  const entry = queue.entryById(app.editingEntryId);
  return entry !== null && entry.kind === 'traced' ? entry : null;
});

// Editing a traced queue row opens the tab at the layout step: the entry's
// tools, placements, footprint, height and shared options are rehydrated into
// the trace and designer stores. The photo itself is not stored with the
// entry, so the earlier steps start empty (see the sentence in step 1).
watch(
  () => (app.editingKind === 'traced' ? app.editingEntryId : null),
  (entryId) => {
    if (entryId === null) return;
    const entry = queue.entryById(entryId);
    if (entry === null || entry.kind !== 'traced') return;
    trace.tools = JSON.parse(JSON.stringify(entry.pockets.tools));
    trace.placements = JSON.parse(JSON.stringify(entry.pockets.placements));
    trace.selectedToolId = null;
    trace.gridX = entry.gridX;
    trace.gridY = entry.gridY;
    // The stored footprint is authoritative; auto sizing must not shrink it.
    trace.gridManual = true;
    designer.$patch({
      heightUnits: entry.heightUnits,
      stackingLip: entry.stackingLip,
      magnetHoles: entry.magnetHoles,
      labelText: entry.labelText,
      labelText2: entry.labelText2,
      labelIcon: entry.labelIcon,
      notes: entry.notes ?? '',
    });
    quantity.value = entry.quantity;
  },
  { immediate: true },
);

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

const { meshes, errorMessage } = useBinPreview(
  () => pocketParams.value,
  (params) => generatePocketBin(params as PocketBinParams),
);

const addError = ref<string | null>(null);

function addToQueue(): void {
  addError.value = null;
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
  if (editingEntry.value !== null) {
    const { dividerCountX, dividerCountY, ...shared } = binParams;
    void dividerCountX;
    void dividerCountY;
    queue.update(editingEntry.value.id, {
      ...shared,
      pockets,
      quantity: quantity.value,
      notes: cleanNotes === '' ? undefined : cleanNotes,
    });
    app.stopEditing();
  } else {
    const id = queue.add(binParams, quantity.value, { kind: 'traced', pockets });
    if (cleanNotes !== '') queue.update(id, { notes: cleanNotes });
  }
  trace.reset();
  quantity.value = 1;
}

function cancelEdit(): void {
  app.stopEditing();
  trace.reset();
  quantity.value = 1;
}
</script>

<template>
  <div class="d-flex flex-column ga-5">
    <div>
      <div class="step-head">1. Photo</div>
      <p
        v-if="editingEntry !== null && rectifiedPreview === null"
        class="text-body-2 text-medium-emphasis mb-2"
      >
        Tracing new tools needs the original photo; load it again here.
        The traced pockets of this entry are already in the layout step below.
      </p>
      <PhotoStep />
      <div v-if="encodeMs !== null" class="text-caption text-medium-emphasis mt-1 readout">
        <div><span>Sheet encoding time</span><span>{{ encodeMs === 0 ? 'reused cached embedding' : `${encodeMs.toFixed(0)} ms` }}</span></div>
      </div>
    </div>

    <div v-if="rectifiedPreview !== null && embedReady">
      <div class="step-head">2. Trace tools</div>
      <TraceStep />
    </div>

    <div v-if="tools.length > 0 || rectifiedPreview !== null">
      <div class="step-head">3. Lay out the bin</div>
      <LayoutStep />
    </div>

    <div v-if="tools.length > 0">
      <div class="step-head">4. Bin options and queue</div>
      <v-row>
        <v-col cols="12" md="6">
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
          <v-alert v-if="errorMessage" type="error" class="mt-4" density="compact">
            {{ errorMessage }}
          </v-alert>
          <v-alert v-if="addError" type="warning" class="mt-2" density="compact">
            {{ addError }}
          </v-alert>
          <div class="d-flex ga-2 mt-4">
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
        </v-col>
        <v-col cols="12" md="6">
          <v-card variant="outlined" class="preview-card">
            <BinViewport
              v-if="previewLoaded"
              :mesh="meshes?.body ?? null"
              :label="meshes?.label ?? null"
            />
            <div
              v-else
              class="d-flex flex-column align-center justify-center text-center fill-height pa-8"
            >
              <v-icon icon="mdi-cube-outline" size="64" class="mb-4 text-medium-emphasis" />
              <p class="text-body-2 text-medium-emphasis mb-4">
                The 3D preview is paused on small screens.
              </p>
              <v-btn color="primary" variant="tonal" @click="previewLoaded = true">
                Load preview
              </v-btn>
            </div>
          </v-card>
        </v-col>
      </v-row>
    </div>
  </div>
</template>

<style scoped>
.step-head {
  font-weight: 700;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgb(var(--v-theme-primary));
  margin-bottom: 8px;
}

.preview-card {
  min-height: 320px;
}

.readout > div {
  display: flex;
  gap: 12px;
}

.readout span:first-child {
  min-width: 160px;
}
</style>
