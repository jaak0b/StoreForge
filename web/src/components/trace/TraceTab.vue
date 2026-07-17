<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useDisplay } from 'vuetify';
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

const designer = useBinDesigner();
const trace = useToolTrace();
const queue = useBinQueue();
const { smAndDown } = useDisplay();

const { labelText, labelIcon, heightUnits, notes } = storeToRefs(designer);
const { rectifiedPreview, embedReady, encodeMs, tools } = storeToRefs(trace);

const quantity = ref(1);
const previewLoaded = ref(!smAndDown.value);

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
  const id = queue.add(
    {
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
    },
    quantity.value,
  );
  queue.update(id, {
    pockets,
    ...(cleanNotes !== '' ? { notes: cleanNotes } : {}),
  });
  trace.reset();
  quantity.value = 1;
}
</script>

<template>
  <div class="d-flex flex-column ga-5">
    <div>
      <div class="step-head">1. Photo</div>
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
          <v-btn
            color="primary"
            variant="flat"
            size="large"
            class="mt-4"
            block
            @click="addToQueue"
          >
            Add to queue
          </v-btn>
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
