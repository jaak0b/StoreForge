<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useApp } from '../../stores/app';
import { useBinDesigner } from '../../stores/binDesigner';
import { useBinQueue } from '../../stores/binQueue';
import { useToolTrace } from '../../stores/toolTrace';
import type { TracedBin } from '../../engine/plan/types';
import type { PaperCorners } from '../../engine/trace/types';
import { getPhoto } from '../../photoStore';
import { embedImage, loadPhoto, rectifyPaper } from '../../visionClient';
import PhotoStage from './PhotoStage.vue';
import TraceCanvas from './TraceCanvas.vue';
import LayoutCanvas from './LayoutCanvas.vue';
import ToolRail from './ToolRail.vue';

/**
 * The Tool trace tab of the add-bin card, in two stages: a Photo stage
 * (photograph tools on a reference sheet, confirm its corners) and a
 * trace-and-lay-out workspace (one canvas switching between click-to-trace
 * and bin layout, beside a rail with the tools, bin options, preview and
 * queue actions). The trace state lives in the toolTrace store so it
 * survives tab switches; the photo itself stays in the vision worker.
 */

const app = useApp();
const designer = useBinDesigner();
const trace = useToolTrace();
const queue = useBinQueue();

const { rectifiedPreview, embedReady, tools, workspaceMode } = storeToRefs(trace);

/** 1 shows the Photo stage, 2 the trace-and-lay-out workspace. */
const stage = ref<1 | 2>(1);

/** The queue entry being edited on this tab, or null when designing a new bin. */
const editingEntry = computed(() => {
  if (app.editingKind !== 'traced' || app.editingEntryId === null) return null;
  const entry = queue.entryById(app.editingEntryId);
  return entry !== null && entry.kind === 'traced' ? entry : null;
});

// The entry's original photo when it is still in this device's photo store,
// loaded when an edit starts; null while unknown or when it is not stored.
const storedPhoto = shallowRef<Blob | null>(null);
/** True once the photo-store lookup came back empty for the edited entry. */
const photoMissing = ref(false);
const resumeBusy = ref(false);
const resumeError = ref<string | null>(null);

async function lookUpStoredPhoto(entry: TracedBin): Promise<void> {
  storedPhoto.value = null;
  photoMissing.value = false;
  if (entry.traceSourceId === undefined || entry.paper === undefined) {
    photoMissing.value = true;
    return;
  }
  try {
    const blob = await getPhoto(entry.traceSourceId);
    storedPhoto.value = blob;
    photoMissing.value = blob === null;
  } catch (error) {
    // Photo storage being unreadable degrades to layout-only editing.
    console.error('Reading the stored trace photo failed.', error);
    photoMissing.value = true;
  }
}

/**
 * Loads the stored photo back into the vision worker, applies the entry's
 * saved sheet corners and size (no re-detection), and rectifies plus embeds
 * so the trace canvas can restore each tool's clicks.
 */
async function resumeTrace(): Promise<void> {
  const entry = editingEntry.value;
  const blob = storedPhoto.value;
  if (entry === null || blob === null || entry.paper === undefined) return;
  resumeBusy.value = true;
  resumeError.value = null;
  try {
    const info = await loadPhoto(await blob.arrayBuffer());
    if (trace.photoUrl !== null) URL.revokeObjectURL(trace.photoUrl);
    trace.photoUrl = URL.createObjectURL(blob);
    trace.photoSize = info;
    trace.photoBlob = blob;
    trace.sourceId = entry.traceSourceId ?? null;
    trace.corners = JSON.parse(JSON.stringify(entry.paper.corners)) as PaperCorners;
    trace.paperKind = entry.paper.kind;
    const rectified = await rectifyPaper(
      JSON.parse(JSON.stringify(entry.paper.corners)) as PaperCorners,
      entry.paper.kind,
    );
    trace.calibration = rectified.calibration;
    trace.rectifiedPreview = rectified.preview;
    trace.embedReady = false;
    const embed = await embedImage();
    trace.encodeMs = embed.encodeMs;
    trace.embedReady = true;
  } catch (error) {
    resumeError.value =
      error instanceof Error ? error.message : 'Restoring the trace photo failed.';
  } finally {
    resumeBusy.value = false;
  }
}

// Editing a traced queue row opens the workspace stage in layout mode: the
// entry's tools, placements, footprint, height and shared options are
// rehydrated into the trace and designer stores. The photo is looked up in
// the photo store; when found, the trace can be resumed on demand (switching
// to Trace mode or re-tracing a tool loads it back into the vision worker).
watch(
  () => (app.editingKind === 'traced' ? app.editingEntryId : null),
  (entryId) => {
    if (entryId === null) return;
    const entry = queue.entryById(entryId);
    if (entry === null || entry.kind !== 'traced') return;
    void lookUpStoredPhoto(entry);
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
    stage.value = 2;
    trace.workspaceMode = 'layout';
  },
  { immediate: true },
);

/** True once the workspace stage has anything to show. */
const workspaceReady = computed(
  () =>
    rectifiedPreview.value !== null || tools.value.length > 0 || editingEntry.value !== null,
);

/** True when Trace mode can run now or after resuming the stored photo. */
const traceModeAvailable = computed(
  () => embedReady.value || storedPhoto.value !== null,
);

function onSheetConfirmed(): void {
  stage.value = 2;
  trace.workspaceMode = 'trace';
}

/** Switches the workspace canvas, resuming the stored photo when needed. */
async function setWorkspaceMode(mode: 'trace' | 'layout'): Promise<void> {
  if (mode === 'trace' && !embedReady.value) {
    if (storedPhoto.value === null) return;
    await resumeTrace();
    if (!trace.embedReady) return;
  }
  workspaceMode.value = mode;
}

/** Re-traces a tool from its stored clicks, resuming the photo when needed. */
async function onRetrace(toolId: string): Promise<void> {
  if (!embedReady.value) {
    if (storedPhoto.value === null) return;
    await resumeTrace();
    if (!trace.embedReady) return;
  }
  trace.selectedToolId = toolId;
  trace.retraceRequestId = toolId;
  workspaceMode.value = 'trace';
}

/** After a save or a cancelled edit the tab starts over at the Photo stage. */
function restart(): void {
  stage.value = 1;
  storedPhoto.value = null;
  photoMissing.value = false;
  resumeError.value = null;
}
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <div class="d-flex align-center ga-1 breadcrumb">
      <v-chip
        :variant="stage === 1 ? 'flat' : 'outlined'"
        :color="stage === 1 ? 'primary' : undefined"
        size="small"
        label
        @click="stage = 1"
      >
        Photo
      </v-chip>
      <v-icon icon="mdi-chevron-right" size="16" class="text-medium-emphasis" />
      <v-chip
        :variant="stage === 2 ? 'flat' : 'outlined'"
        :color="stage === 2 ? 'primary' : undefined"
        :disabled="!workspaceReady"
        size="small"
        label
        @click="stage = 2"
      >
        Trace and lay out
      </v-chip>
    </div>

    <PhotoStage v-if="stage === 1" @confirmed="onSheetConfirmed" />

    <div v-else class="stage-panes">
      <div class="canvas-pane">
        <v-btn-toggle
          :model-value="workspaceMode"
          mandatory
          density="comfortable"
          variant="outlined"
          class="mb-3"
          @update:model-value="setWorkspaceMode($event as 'trace' | 'layout')"
        >
          <v-btn value="trace" :disabled="!traceModeAvailable" :loading="resumeBusy">
            Trace
          </v-btn>
          <v-btn value="layout">Layout</v-btn>
        </v-btn-toggle>
        <p
          v-if="editingEntry !== null && photoMissing && !embedReady"
          class="text-body-2 text-medium-emphasis"
        >
          The original photo of this trace is not stored on this device, so its
          tools cannot be re-traced. Edit the layout here, or load a new photo
          in the Photo stage to trace more tools.
        </p>
        <v-alert v-if="resumeError" type="error" density="compact" class="mb-2">
          {{ resumeError }}
        </v-alert>
        <p v-if="resumeBusy" class="text-body-2 text-medium-emphasis">
          Restoring the stored trace photo.
        </p>
        <v-progress-linear v-if="resumeBusy" indeterminate class="mb-2" />
        <TraceCanvas
          v-if="embedReady"
          v-show="workspaceMode === 'trace'"
          @accepted="workspaceMode = 'layout'"
        />
        <LayoutCanvas v-show="workspaceMode === 'layout'" />
      </div>
      <ToolRail
        class="rail"
        :editing-entry="editingEntry"
        :retrace-available="traceModeAvailable"
        @retrace="onRetrace"
        @saved="restart"
        @cancelled="restart"
      />
    </div>
  </div>
</template>

<style scoped>
.breadcrumb .v-chip {
  cursor: pointer;
}

.stage-panes {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}

.canvas-pane {
  flex: 1 1 auto;
  min-width: 0;
}

.rail {
  flex: 0 0 360px;
  max-width: 360px;
}

@media (max-width: 959px) {
  .stage-panes {
    flex-direction: column;
  }

  .rail {
    flex: 1 1 auto;
    max-width: none;
    width: 100%;
  }
}
</style>
