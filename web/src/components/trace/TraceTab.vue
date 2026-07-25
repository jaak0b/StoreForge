<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useApp } from '../../stores/app';
import { useBinDesigner } from '../../stores/binDesigner';
import { useBinQueue } from '../../stores/binQueue';
import { useToolTrace } from '../../stores/toolTrace';
import { assertNever, binOf } from '../../engine/plan/types';
import type { TraceSession } from '../../engine/trace/types';
import { worldFromEntry } from '../../engine/trace/layoutModel';
import { getPhoto } from '../../photoStore';
import { cloneSketch } from '../../engine/sketch/model';
import PhotoStage from './PhotoStage.vue';
import TraceCanvas from './TraceCanvas.vue';
import LayoutWorkspace from './LayoutWorkspace.vue';
import SketchWorkspace from './sketch/SketchWorkspace.vue';
import SourceListStage from './SourceListStage.vue';
import { useSketchEditor } from '../../stores/sketchEditor';

/**
 * The Tool trace tab of the add-bin card. Its home stage is a source list:
 * one card per photographed sheet and per sketched tool, plus the actions
 * that add a new source. Opening a card enters modal work on that one
 * source: the Photo stage (photograph tools, confirm sheet corners), the
 * trace-and-lay-out workspace (Trace mode fills the tab with the
 * click-to-trace canvas; Layout mode is a full-bleed layout canvas with
 * floating controls and an advanced drawer), or the sketch workspace. Every
 * workspace's way back is the source list. The trace state lives in the
 * toolTrace store so it survives tab switches; the photo itself stays in
 * the vision worker.
 */

const app = useApp();
const designer = useBinDesigner();
const trace = useToolTrace();
const queue = useBinQueue();
const sketchEditor = useSketchEditor();

const { rectifiedPreview, embedReady, tools, workspaceMode } = storeToRefs(trace);

/** Which screen the tab shows. Workspaces are modal work on one source. */
const stage = ref<'sources' | 'photo' | 'sketch' | 'workspace'>('sources');

/** Sketched tools, one source card each. */
const sketchTools = computed(() => trace.tools.filter((t) => t.source.kind === 'sketch'));

/** Starts a fresh sketch from the Sources stage. */
function drawShape(): void {
  sketchEditor.startNewSketch();
  stage.value = 'sketch';
}

/** Opens the photo stage to add a new sheet. */
function addPhotoSheet(): void {
  stage.value = 'photo';
}

/** Every workspace's way back; also the breadcrumb's first chip. */
function backToSources(): void {
  stage.value = 'sources';
}

/**
 * Loads a session's photo (from the page's blob map, or the photo store)
 * and atomically activates it. Returns false with sourcesError set when the
 * photo is not available on this device.
 */
const sourcesBusy = ref(false);
const sourcesError = ref<string | null>(null);

async function ensureSessionActive(sessionId: string): Promise<boolean> {
  if (trace.activeSessionId === sessionId && trace.embedReady) return true;
  const session = trace.sessions.find((s) => s.id === sessionId);
  if (session === undefined) {
    sourcesError.value = 'That photo sheet is no longer part of this bin.';
    return false;
  }
  sourcesBusy.value = true;
  sourcesError.value = null;
  try {
    let blob = trace.sessionBlobs.get(sessionId) ?? null;
    if (blob === null) blob = await getPhoto(session.traceSourceId);
    if (blob === null) {
      sourcesError.value =
        'The photo of this sheet is not stored on this device, so its tools cannot be re-traced. You can still edit the layout.';
      return false;
    }
    await trace.activateSession(sessionId, blob);
    return true;
  } catch (error) {
    sourcesError.value =
      error instanceof Error ? error.message : 'Restoring the trace photo failed.';
    return false;
  } finally {
    sourcesBusy.value = false;
  }
}

/** A sheet card: activate its session and open the trace workspace. */
async function openSheet(sessionId: string): Promise<void> {
  if (!(await ensureSessionActive(sessionId))) return;
  stage.value = 'workspace';
  trace.workspaceMode = 'trace';
}

/** A sketch card: open the tool's stored sketch in the sketch workspace. */
function editSketchedTool(toolId: string): void {
  const tool = trace.tools.find((t) => t.id === toolId);
  if (tool === undefined) return;
  switch (tool.source.kind) {
    case 'photo':
      return; // photo tools re-trace through onRetrace instead
    case 'sketch':
      sketchEditor.loadSketch(tool.source.sketch, toolId);
      stage.value = 'sketch';
      return;
    case 'primitive':
      return; // a primitive shape has nothing to reopen
    default:
      return assertNever(tool.source);
  }
}

/** Cancelling the sketch returns to the stage that opened it: the source list. */
function cancelSketch(): void {
  stage.value = 'sources';
}

/** Error from the last finish attempt, shown as an alert over the workspace. */
const sketchFinishError = ref<string | null>(null);

/**
 * Validates the sketch through the profile extractor and drops the resulting
 * outline into the normal tool placement step. The sketch itself travels on
 * the tool so it can be reopened and edited later.
 */
async function finishSketch(): Promise<void> {
  sketchFinishError.value = null;
  // One final solve so the extracted profile is the solved geometry.
  await sketchEditor.solveNow();
  const state = sketchEditor.solveState;
  if (state.status === 'conflicting') {
    sketchFinishError.value =
      'The sketch has conflicting constraints. Remove one of the constraints listed under the canvas.';
    return;
  }
  if (state.status === 'failed') {
    sketchFinishError.value = state.message;
    return;
  }
  const picked = sketchEditor.outlineForFinish();
  if (!picked.ok) {
    sketchFinishError.value = picked.error;
    return;
  }
  const source = { kind: 'sketch' as const, sketch: cloneSketch(sketchEditor.sketch) };
  if (sketchEditor.editingToolId !== null) {
    // Re-editing a sketched tool: replace its outline and sketch in place.
    const tool = trace.tools.find((t) => t.id === sketchEditor.editingToolId);
    if (tool !== undefined) {
      trace.replaceToolOutline(tool.id, picked.outline, source);
    }
  } else {
    trace.addTool(picked.outline, 'Sketched shape', source);
  }
  stage.value = 'workspace';
  trace.workspaceMode = 'layout';
}

/** The queue entry being edited on this tab, or null when designing a new bin. */
const editingEntry = computed(() => {
  if (app.editingKind !== 'traced' || app.editingEntryId === null) return null;
  const entry = queue.entryById(app.editingEntryId);
  return entry !== null && binOf(entry.product)?.origin === 'traced' ? entry : null;
});

// Editing a traced queue row opens the workspace stage in layout mode: the
// entry's tools, placements, footprint, height and shared options are
// rehydrated into the trace and designer stores. Its sessions are loaded as
// source cards; opening one (or re-tracing a tool) resolves and activates
// that session's photo on demand through ensureSessionActive.
watch(
  () => (app.editingKind === 'traced' ? app.editingEntryId : null),
  (entryId) => {
    if (entryId === null) return;
    const entry = queue.entryById(entryId);
    if (entry === null) return;
    const bin = binOf(entry.product);
    if (bin === null || bin.origin !== 'traced') return;
    // Cloned: commitSessionPaper mutates a session object in place on a
    // later re-confirm, and entry.traceSessions is the persisted plan data.
    trace.sessions = JSON.parse(JSON.stringify(bin.traceSessions)) as TraceSession[];
    trace.tools = JSON.parse(JSON.stringify(bin.pockets.tools));
    // Stored placements are bin-centred; the layout model works in the world
    // frame, so place the resumed layout inside the bin's world cells.
    trace.placements = worldFromEntry(
      JSON.parse(JSON.stringify(bin.pockets.placements)),
      bin.gridX,
      bin.gridY,
    );
    trace.selectedToolId = null;
    // Rehydrate the bin's manual cavity edits into the shared edit session so
    // they round-trip through the designer and fold onto the saved carve again.
    trace.setEdits(bin.edits);
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
    stage.value = 'workspace';
    trace.workspaceMode = 'layout';
  },
  { immediate: true },
);

/** True once the workspace stage has anything to show. */
const workspaceReady = computed(
  () =>
    rectifiedPreview.value !== null || tools.value.length > 0 || editingEntry.value !== null,
);

/** True when some sheet exists to trace on (active now or restorable). */
const traceModeAvailable = computed(() => trace.embedReady || trace.sessions.length > 0);

function onSheetConfirmed(): void {
  // PhotoStage committed the session's paper on confirm; tracing starts now.
  stage.value = 'workspace';
  trace.workspaceMode = 'trace';
}

// Layout mode needs at least one tool; whenever the workspace would show
// the layout with zero tools (the last tool was removed, or the stage was
// reached through the breadcrumb with the store still in layout mode) it
// falls back to the source list: with no tools the workspace has nothing to
// lay out, and the source list is now the home that offers every way
// forward.
watch(
  [stage, workspaceMode, () => tools.value.length],
  ([stageNow, mode, count]) => {
    if (stageNow === 'workspace' && count === 0 && mode === 'layout') {
      backToSources();
    }
  },
);

/** Re-traces a photo tool: activate its own session, then open trace mode. */
async function onRetrace(toolId: string): Promise<void> {
  const tool = trace.tools.find((t) => t.id === toolId);
  if (tool === undefined || tool.source.kind !== 'photo') return;
  if (!(await ensureSessionActive(tool.source.sessionId))) return;
  trace.selectedToolId = toolId;
  trace.retraceRequestId = toolId;
  stage.value = 'workspace';
  trace.workspaceMode = 'trace';
}

/** The Photo stage reported a new pending photo, clearing any prior error. */
function onPhotoReplaced(): void {
  sourcesError.value = null;
}

/** The toolbar's trace-another action: back to the source list to pick a sheet. */
function onTraceAnother(): void {
  if (trace.sessions.length === 1) {
    // One sheet: skip the list and go straight back to tracing on it.
    void openSheet(trace.sessions[0].id);
    return;
  }
  backToSources();
}

/** After a save or a cancelled edit the tab starts over at the source list. */
function restart(): void {
  stage.value = 'sources';
  sourcesError.value = null;
  // The store is already reset by the rail on save and cancel; resetting
  // again is a no-op there and guarantees a blank tab from any other path.
  trace.reset();
}
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <div class="d-flex align-center ga-1 breadcrumb">
      <v-chip
        :variant="stage !== 'workspace' ? 'flat' : 'outlined'"
        :color="stage !== 'workspace' ? 'primary' : undefined"
        size="small"
        label
        @click="backToSources"
      >
        Sources
      </v-chip>
      <v-icon icon="mdi-chevron-right" size="16" class="text-medium-emphasis" />
      <v-chip
        :variant="stage === 'workspace' ? 'flat' : 'outlined'"
        :color="stage === 'workspace' ? 'primary' : undefined"
        :disabled="!workspaceReady"
        size="small"
        label
        @click="stage = 'workspace'"
      >
        Trace and lay out
      </v-chip>
    </div>

    <template v-if="stage === 'sources'">
      <v-alert v-if="sourcesError" type="error" density="compact">
        {{ sourcesError }}
      </v-alert>
      <v-progress-linear v-if="sourcesBusy" indeterminate />
      <SourceListStage
        :sessions="trace.sessions"
        :sketch-tools="sketchTools"
        :busy="sourcesBusy"
        @open-sheet="openSheet"
        @open-sketch="editSketchedTool"
        @add-photo="addPhotoSheet"
        @draw-shape="drawShape"
      />
    </template>

    <template v-else-if="stage === 'photo'">
      <div>
        <v-btn variant="outlined" prepend-icon="mdi-arrow-left" @click="backToSources">
          Back to sources
        </v-btn>
      </div>
      <PhotoStage @confirmed="onSheetConfirmed" @photo-replaced="onPhotoReplaced" />
    </template>

    <template v-else-if="stage === 'sketch'">
      <v-alert v-if="sketchFinishError !== null" type="error" density="compact" class="mb-2">
        {{ sketchFinishError }}
      </v-alert>
      <SketchWorkspace @cancel="cancelSketch" @finish="finishSketch" />
    </template>

    <div v-else>
      <div v-show="workspaceMode === 'trace'">
        <div class="mb-3">
          <v-btn
            variant="outlined"
            prepend-icon="mdi-arrow-left"
            @click="tools.length > 0 ? (trace.workspaceMode = 'layout') : backToSources()"
          >
            {{ tools.length > 0 ? 'Back to layout' : 'Back to sources' }}
          </v-btn>
        </div>
        <TraceCanvas v-if="embedReady" @accepted="workspaceMode = 'layout'" />
      </div>
      <div v-show="workspaceMode === 'layout'">
        <v-alert v-if="sourcesError" type="error" density="compact" class="mb-2">
          {{ sourcesError }}
        </v-alert>
        <p v-if="sourcesBusy" class="text-body-2 text-medium-emphasis">
          Restoring the stored trace photo.
        </p>
        <v-progress-linear v-if="sourcesBusy" indeterminate class="mb-2" />
        <LayoutWorkspace
          :editing-entry="editingEntry"
          :retrace-available="traceModeAvailable"
          @trace-another="onTraceAnother"
          @retrace="onRetrace"
          @edit-sketch="editSketchedTool"
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
