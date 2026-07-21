<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useApp } from '../../stores/app';
import { useBinDesigner } from '../../stores/binDesigner';
import { useBinQueue } from '../../stores/binQueue';
import { useToolTrace } from '../../stores/toolTrace';
import { binOf, type TracedBin } from '../../engine/plan/types';
import type { PaperCorners } from '../../engine/trace/types';
import { worldFromEntry } from '../../engine/trace/layoutModel';
import { getPhoto } from '../../photoStore';
import { embedImage, loadPhoto, rectifyPaper } from '../../visionClient';
import PhotoStage from './PhotoStage.vue';
import TraceCanvas from './TraceCanvas.vue';
import LayoutWorkspace from './LayoutWorkspace.vue';

/**
 * The Tool trace tab of the add-bin card, in two stages: a Photo stage
 * (photograph tools on a reference sheet, confirm its corners) and a
 * trace-and-lay-out workspace with two gated modes: Trace mode fills the
 * whole tab with the click-to-trace canvas, and Layout mode (reachable only
 * once at least one tool exists) is a full-bleed layout canvas with floating
 * controls and an advanced drawer (LayoutWorkspace). The trace state lives
 * in the toolTrace store so it survives tab switches; the photo itself
 * stays in the vision worker.
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
  return entry !== null && binOf(entry.product)?.origin === 'traced' ? entry : null;
});

/** The traced bin of the entry being edited, or null. */
const editingBin = computed<TracedBin | null>(() => {
  const entry = editingEntry.value;
  if (entry === null) return null;
  const bin = binOf(entry.product);
  return bin !== null && bin.origin === 'traced' ? bin : null;
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
  const entry = editingBin.value;
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
    const rectified = await rectifyPaper(entry.paper.corners, entry.paper.kind);
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
    if (entry === null) return;
    const bin = binOf(entry.product);
    if (bin === null || bin.origin !== 'traced') return;
    void lookUpStoredPhoto(bin);
    trace.tools = JSON.parse(JSON.stringify(bin.pockets.tools));
    // Stored placements are bin-centred; the layout model works in the world
    // frame, so place the resumed layout inside the bin's world cells.
    trace.placements = worldFromEntry(
      JSON.parse(JSON.stringify(bin.pockets.placements)),
      bin.gridX,
      bin.gridY,
    );
    trace.selectedToolId = null;
    // The stored footprint is a floor; the layout can still demand more.
    trace.gridX = bin.gridX;
    trace.gridY = bin.gridY;
    trace.gridManual = true;
    const content = entry.product.kind === 'binWithInsert' ? entry.product.insert : null;
    designer.$patch({
      productChoice:
        entry.product.kind === 'binWithInsert'
          ? 'binWithInsert'
          : entry.product.kind === 'bin' && !entry.product.labelSlot
            ? 'plainBin'
            : 'bin',
      fused: entry.product.kind === 'binWithInsert' ? entry.product.fused ?? false : false,
      heightUnits: bin.heightUnits,
      magnetHoles: bin.magnetHoles,
      labelText: content?.text ?? '',
      labelText2: content?.text2 ?? '',
      labelIcon: content?.icon ?? null,
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

// Layout mode needs at least one tool; whenever the workspace would show
// the layout with zero tools (the last tool was removed, or the stage was
// reached through the breadcrumb with the store still in layout mode) it
// falls back to Trace mode if tracing is possible. Without a photo
// (layout-only editing) the layout stays up so a basic shape can still be
// added from the rail.
watch(
  [stage, workspaceMode, () => tools.value.length],
  ([stageNow, mode, count]) => {
    if (stageNow === 2 && count === 0 && mode === 'layout' && traceModeAvailable.value) {
      void setWorkspaceMode('trace');
    }
  },
);

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

/**
 * Opens the Photo stage. During an edit whose photo is stored but not yet
 * loaded, the photo is first restored into the workspace, so the stage shows
 * it with the saved sheet corners instead of the empty dropzone.
 */
async function openPhotoStage(): Promise<void> {
  if (trace.photoUrl === null && storedPhoto.value !== null) {
    await resumeTrace();
  }
  stage.value = 1;
}

/**
 * A newly chosen photo has already reset the trace store. The edited entry's
 * stored photo is no longer the one in the workspace, so it is dropped here
 * too; otherwise resuming it would load the old photo back over the new one.
 */
function onPhotoReplaced(): void {
  storedPhoto.value = null;
  photoMissing.value = false;
  resumeError.value = null;
}

/** After a save or a cancelled edit the tab starts over at the Photo stage. */
function restart(): void {
  stage.value = 1;
  storedPhoto.value = null;
  photoMissing.value = false;
  resumeError.value = null;
  // The store is already reset by the rail on save and cancel; resetting
  // again is a no-op there and guarantees a blank tab from any other path.
  trace.reset();
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
        @click="openPhotoStage"
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

    <template v-if="stage === 1">
      <v-alert v-if="resumeError" type="error" density="compact">
        {{ resumeError }}
      </v-alert>
      <v-progress-linear v-if="resumeBusy" indeterminate />
      <PhotoStage @confirmed="onSheetConfirmed" @photo-replaced="onPhotoReplaced" />
    </template>

    <div v-else>
      <div v-show="workspaceMode === 'trace'">
        <div v-if="tools.length > 0" class="mb-3">
          <v-btn
            variant="outlined"
            prepend-icon="mdi-arrow-left"
            @click="setWorkspaceMode('layout')"
          >
            Back to layout
          </v-btn>
        </div>
        <TraceCanvas v-if="embedReady" @accepted="workspaceMode = 'layout'" />
      </div>
      <div v-show="workspaceMode === 'layout'">
        <p
          v-if="editingEntry !== null && photoMissing && !embedReady"
          class="text-body-2 text-medium-emphasis"
        >
          The original photo of this trace is not stored on this device, so its
          tools cannot be re-traced. You can still edit the layout here.
          Loading a new photo in the Photo stage starts a new trace and
          discards these tools.
        </p>
        <v-alert v-if="resumeError" type="error" density="compact" class="mb-2">
          {{ resumeError }}
        </v-alert>
        <p v-if="resumeBusy" class="text-body-2 text-medium-emphasis">
          Restoring the stored trace photo.
        </p>
        <v-progress-linear v-if="resumeBusy" indeterminate class="mb-2" />
        <LayoutWorkspace
          :editing-entry="editingEntry"
          :retrace-available="traceModeAvailable"
          @trace-another="setWorkspaceMode('trace')"
          @retrace="onRetrace"
          @saved="restart"
          @cancelled="restart"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.breadcrumb .v-chip {
  cursor: pointer;
}
</style>
