<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useBinQueue } from '../stores/binQueue';
import { generateLabeledBin, generateLabeledBinUnion } from '../workerClient';
import { meshToStlBlob } from '../engine/gridfinity/stlExport';
import { PITCH } from '../engine/gridfinity/constants';
import type { BinEntry } from '../engine/plan/types';
import type { LabeledBinParams } from '../engine/gridfinity/types';
import {
  arrangePlate,
  type FootprintItem,
  type Placement,
} from '../engine/plate/arranger';
import { mergePlacedMeshes, type PlacedMesh } from '../engine/plate/placement';
import { writePlate3mf, type PlateItem } from '../engine/threeMf/writer';

const queue = useBinQueue();

/** Footprint clearance: the base is 0.5 mm smaller than the grid pitch. */
const FOOTPRINT_CLEARANCE = 0.5;

// Plate size selection.
const platePresets = [
  { title: '256 x 256 mm', value: '256' },
  { title: '220 x 220 mm', value: '220' },
  { title: '180 x 180 mm', value: '180' },
  { title: 'Custom size', value: 'custom' },
];
const platePreset = ref('256');
const customWidth = ref(256);
const customDepth = ref(256);

const plateWidth = computed(() =>
  platePreset.value === 'custom' ? Number(customWidth.value) : Number(platePreset.value),
);
const plateDepth = computed(() =>
  platePreset.value === 'custom' ? Number(customDepth.value) : Number(platePreset.value),
);
const plateSizeValid = computed(
  () =>
    Number.isFinite(plateWidth.value) &&
    Number.isFinite(plateDepth.value) &&
    plateWidth.value >= 50 &&
    plateDepth.value >= 50,
);

// Bin selection: queued entries only, each with an adjustable copy count.
const queuedEntries = computed(() => queue.entries.filter((e) => e.status === 'queued'));
const selectedIds = ref<Set<string>>(new Set());
const copyCounts = ref<Map<string, number>>(new Map());

watch(
  queuedEntries,
  (entries) => {
    const ids = new Set(entries.map((e) => e.id));
    for (const id of [...selectedIds.value]) {
      if (!ids.has(id)) selectedIds.value.delete(id);
    }
  },
  { deep: false },
);

function copiesOf(entry: BinEntry): number {
  return copyCounts.value.get(entry.id) ?? entry.quantity;
}

function setCopies(entry: BinEntry, value: number): void {
  const count = Math.max(1, Math.floor(Number(value) || 1));
  const next = new Map(copyCounts.value);
  next.set(entry.id, count);
  copyCounts.value = next;
}

function toggleSelected(entry: BinEntry): void {
  const next = new Set(selectedIds.value);
  if (next.has(entry.id)) next.delete(entry.id);
  else next.add(entry.id);
  selectedIds.value = next;
}

function entryTitle(entry: BinEntry): string {
  const size = `${entry.gridX} x ${entry.gridY} x ${entry.heightUnits}`;
  return entry.labelText !== '' ? `${entry.labelText} (${size})` : size;
}

function footprintOf(entry: BinEntry): { widthMm: number; depthMm: number } {
  return {
    widthMm: entry.gridX * PITCH - FOOTPRINT_CLEARANCE,
    depthMm: entry.gridY * PITCH - FOOTPRINT_CLEARANCE,
  };
}

// Arrangement: every selected entry expanded to its copies, packed onto the
// plate. Instance ids are "entryId#copyIndex" so placements map back.
const arrangement = computed(() => {
  const items: FootprintItem[] = [];
  for (const entry of queuedEntries.value) {
    if (!selectedIds.value.has(entry.id)) continue;
    const footprint = footprintOf(entry);
    for (let i = 0; i < copiesOf(entry); i++) {
      items.push({ id: `${entry.id}#${i}`, ...footprint });
    }
  }
  if (!plateSizeValid.value) {
    return { placed: [] as Placement[], overflow: items };
  }
  return arrangePlate(items, {
    plateWidthMm: plateWidth.value,
    plateDepthMm: plateDepth.value,
  });
});

function entryIdOfPlacement(placement: Placement): string {
  return placement.id.slice(0, placement.id.lastIndexOf('#'));
}

function placementLabel(placement: Placement): string {
  const entry = queue.entryById(entryIdOfPlacement(placement));
  if (entry === null) return '';
  return entry.labelText !== ''
    ? entry.labelText
    : `${entry.gridX}x${entry.gridY}`;
}

// Preview scaling: the SVG viewBox is the plate in millimetres.
const previewFontSize = computed(() => Math.max(4, plateWidth.value / 45));

// Generation and downloads.
const generating = ref(false);
const progressText = ref('');
const errorMessage = ref<string | null>(null);

function paramsOf(entry: BinEntry): LabeledBinParams {
  return {
    gridX: entry.gridX,
    gridY: entry.gridY,
    heightUnits: entry.heightUnits,
    stackingLip: entry.stackingLip,
    magnetHoles: entry.magnetHoles,
    labelText: entry.labelText,
    labelIcon: entry.labelIcon,
  };
}

function dedupKey(params: LabeledBinParams): string {
  return JSON.stringify([
    params.gridX,
    params.gridY,
    params.heightUnits,
    params.stackingLip,
    params.magnetHoles,
    params.labelText,
    params.labelIcon,
  ]);
}

interface UniqueBin {
  params: LabeledBinParams;
  name: string;
  placements: Placement[];
}

/** Group the current placements by identical bin design, for one generation each. */
function uniqueBins(): UniqueBin[] {
  const groups = new Map<string, UniqueBin>();
  for (const placement of arrangement.value.placed) {
    const entry = queue.entryById(entryIdOfPlacement(placement));
    if (entry === null) continue;
    const params = paramsOf(entry);
    const key = dedupKey(params);
    let group = groups.get(key);
    if (!group) {
      group = { params, name: entryTitle(entry), placements: [] };
      groups.set(key, group);
    }
    group.placements.push(placement);
  }
  return [...groups.values()];
}

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

const canDownload = computed(
  () => arrangement.value.placed.length > 0 && !generating.value,
);

async function withGeneration(task: () => Promise<void>): Promise<void> {
  generating.value = true;
  errorMessage.value = null;
  try {
    await task();
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'Generating the plate failed.';
  } finally {
    generating.value = false;
    progressText.value = '';
  }
}

async function downloadTwoFilament3mf(): Promise<void> {
  await withGeneration(async () => {
    const bins = uniqueBins();
    const items: PlateItem[] = [];
    for (let i = 0; i < bins.length; i++) {
      progressText.value = `Generating bin ${i + 1} of ${bins.length}`;
      const meshes = await generateLabeledBin(bins[i].params);
      items.push({
        body: meshes.body,
        label: meshes.label,
        name: bins[i].name,
        instances: bins[i].placements.map((p) => ({ xMm: p.xMm, yMm: p.yMm })),
      });
    }
    const bytes = writePlate3mf(items);
    triggerDownload(
      new Blob([bytes.buffer as ArrayBuffer], { type: 'model/3mf' }),
      'gridfinity_plate.3mf',
    );
  });
}

async function downloadSingleColor3mf(): Promise<void> {
  await withGeneration(async () => {
    const bins = uniqueBins();
    const items: PlateItem[] = [];
    for (let i = 0; i < bins.length; i++) {
      progressText.value = `Generating bin ${i + 1} of ${bins.length}`;
      const mesh = await generateLabeledBinUnion(bins[i].params);
      items.push({
        body: mesh,
        label: null,
        name: bins[i].name,
        instances: bins[i].placements.map((p) => ({ xMm: p.xMm, yMm: p.yMm })),
      });
    }
    const bytes = writePlate3mf(items);
    triggerDownload(
      new Blob([bytes.buffer as ArrayBuffer], { type: 'model/3mf' }),
      'gridfinity_plate_single_color.3mf',
    );
  });
}

async function downloadCombinedStl(): Promise<void> {
  await withGeneration(async () => {
    const bins = uniqueBins();
    const placed: PlacedMesh[] = [];
    for (let i = 0; i < bins.length; i++) {
      progressText.value = `Generating bin ${i + 1} of ${bins.length}`;
      const mesh = await generateLabeledBinUnion(bins[i].params);
      for (const placement of bins[i].placements) {
        placed.push({ mesh, xMm: placement.xMm, yMm: placement.yMm });
      }
    }
    const merged = mergePlacedMeshes(placed);
    triggerDownload(meshToStlBlob(merged), 'gridfinity_plate.stl');
  });
}
</script>

<template>
  <v-container fluid class="plate-page">
    <v-toolbar density="comfortable" color="surface" flat rounded>
      <v-toolbar-title>
        Build plate
        <span class="text-body-2 text-medium-emphasis ml-2">
          {{ arrangement.placed.length }} placed
        </span>
      </v-toolbar-title>
    </v-toolbar>

    <v-alert v-if="errorMessage" type="error" density="compact" class="mb-4 mt-2">
      {{ errorMessage }}
    </v-alert>

    <v-row class="mt-1">
      <v-col cols="12" md="5">
        <v-card variant="outlined">
          <v-card-title class="text-body-1">Plate size</v-card-title>
          <v-card-text>
            <v-select
              v-model="platePreset"
              :items="platePresets"
              label="Plate size"
              density="comfortable"
              hide-details
            />
            <div v-if="platePreset === 'custom'" class="d-flex ga-2 mt-3">
              <v-text-field
                v-model.number="customWidth"
                label="Width (mm)"
                type="number"
                min="50"
                density="comfortable"
                hide-details
              />
              <v-text-field
                v-model.number="customDepth"
                label="Depth (mm)"
                type="number"
                min="50"
                density="comfortable"
                hide-details
              />
            </div>
            <p v-if="!plateSizeValid" class="text-error text-body-2 mt-2 mb-0">
              The plate size must be at least 50 mm on each side.
            </p>
          </v-card-text>
        </v-card>

        <v-card variant="outlined" class="mt-4">
          <v-card-title class="text-body-1">Queued bins</v-card-title>
          <v-card-text v-if="queuedEntries.length === 0">
            The queue has no bins waiting to print. Add bins in the designer first.
          </v-card-text>
          <v-list v-else density="comfortable">
            <v-list-item
              v-for="entry in queuedEntries"
              :key="entry.id"
              @click="toggleSelected(entry)"
            >
              <template #prepend>
                <v-checkbox-btn
                  :model-value="selectedIds.has(entry.id)"
                  @click.stop="toggleSelected(entry)"
                />
              </template>
              <v-list-item-title>{{ entryTitle(entry) }}</v-list-item-title>
              <template #append>
                <v-text-field
                  :model-value="copiesOf(entry)"
                  type="number"
                  min="1"
                  density="compact"
                  hide-details
                  style="width: 84px"
                  label="Copies"
                  @click.stop
                  @update:model-value="(v: string) => setCopies(entry, Number(v))"
                />
              </template>
            </v-list-item>
          </v-list>
        </v-card>
      </v-col>

      <v-col cols="12" md="7">
        <v-card variant="outlined">
          <v-card-title class="text-body-1">
            Plate preview ({{ plateWidth }} x {{ plateDepth }} mm)
          </v-card-title>
          <v-card-text>
            <svg
              class="plate-preview"
              :viewBox="`0 0 ${plateWidth} ${plateDepth}`"
              preserveAspectRatio="xMidYMid meet"
            >
              <rect
                x="0"
                y="0"
                :width="plateWidth"
                :height="plateDepth"
                class="plate-preview__plate"
              />
              <!-- Y is flipped so the plate's front edge is at the bottom. -->
              <g
                v-for="placement in arrangement.placed"
                :key="placement.id"
                :transform="`translate(${placement.xMm}, ${plateDepth - placement.yMm})`"
              >
                <rect
                  :x="-placement.widthMm / 2"
                  :y="-placement.depthMm / 2"
                  :width="placement.widthMm"
                  :height="placement.depthMm"
                  rx="3"
                  class="plate-preview__bin"
                />
                <text
                  x="0"
                  y="0"
                  text-anchor="middle"
                  dominant-baseline="central"
                  class="plate-preview__label"
                  :font-size="previewFontSize"
                >
                  {{ placementLabel(placement) }}
                </text>
              </g>
            </svg>
            <v-alert
              v-if="arrangement.overflow.length > 0"
              type="warning"
              variant="tonal"
              density="comfortable"
              class="mt-3"
            >
              {{ arrangement.overflow.length }}
              {{ arrangement.overflow.length === 1 ? 'bin does' : 'bins do' }}
              not fit on this plate and stay queued for the next plate.
            </v-alert>
            <p
              v-else-if="arrangement.placed.length === 0"
              class="text-body-2 text-medium-emphasis mt-3 mb-0"
            >
              Select queued bins on the left to arrange them on the plate.
            </p>
          </v-card-text>
          <v-divider />
          <v-card-text>
            <p class="text-body-2 text-medium-emphasis">
              The two-filament 3MF assigns the bin bodies to extruder 1 and the
              labels to extruder 2, in the layout Orca Slicer and Bambu Studio
              read. The single-color files merge each label into its bin body.
            </p>
            <p v-if="generating" class="text-body-2 mb-2">
              <v-progress-circular indeterminate size="16" width="2" class="mr-2" />
              {{ progressText }}
            </p>
            <div class="d-flex flex-wrap ga-2">
              <v-btn
                color="primary"
                variant="flat"
                prepend-icon="mdi-file-download-outline"
                :disabled="!canDownload"
                :loading="generating"
                @click="downloadTwoFilament3mf"
              >
                Download 3MF (two filaments)
              </v-btn>
              <v-btn
                variant="tonal"
                prepend-icon="mdi-file-download-outline"
                :disabled="!canDownload"
                @click="downloadSingleColor3mf"
              >
                Download 3MF (single color)
              </v-btn>
              <v-btn
                variant="tonal"
                prepend-icon="mdi-file-download-outline"
                :disabled="!canDownload"
                @click="downloadCombinedStl"
              >
                Download combined STL
              </v-btn>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<style scoped>
.plate-page {
  max-width: 1200px;
}

.plate-preview {
  width: 100%;
  display: block;
}

.plate-preview__plate {
  fill: rgb(var(--v-theme-surface-variant));
  stroke: rgba(var(--v-theme-on-surface), 0.3);
  stroke-width: 1;
}

.plate-preview__bin {
  fill: rgba(var(--v-theme-primary), 0.35);
  stroke: rgb(var(--v-theme-primary));
  stroke-width: 0.8;
}

.plate-preview__label {
  fill: rgb(var(--v-theme-on-surface));
}
</style>
