<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useDisplay } from 'vuetify';
import { useApp } from '../stores/app';
import { useBinQueue } from '../stores/binQueue';
import { useBinTemplates } from '../stores/binTemplates';
import { generateLabeledBinUnion } from '../workerClient';
import { meshToStlBlob } from '../engine/gridfinity/stlExport';
import { iconByName } from '../engine/label/icons';
import type { BinEntry, BinTemplate } from '../engine/plan/types';
import FootprintThumb from './FootprintThumb.vue';

const app = useApp();
const queue = useBinQueue();
const templates = useBinTemplates();
const { smAndDown } = useDisplay();

type Filter = 'all' | 'queued' | 'printed';
const filter = ref<Filter>('all');
const errorMessage = ref<string | null>(null);
const downloadingId = ref<string | null>(null);

const filteredEntries = computed(() =>
  filter.value === 'all'
    ? queue.entries
    : queue.entries.filter((entry) => entry.status === filter.value),
);

function sizeLabel(entry: BinEntry): string {
  return `${entry.gridX} x ${entry.gridY} x ${entry.heightUnits}`;
}

function cardTitle(entry: BinEntry): string {
  return entry.labelText !== '' ? entry.labelText : sizeLabel(entry);
}

function labelIconPath(name: string): string {
  return iconByName(name).path;
}

async function downloadStl(entry: BinEntry): Promise<void> {
  downloadingId.value = entry.id;
  errorMessage.value = null;
  try {
    const mesh = await generateLabeledBinUnion({
      gridX: entry.gridX,
      gridY: entry.gridY,
      heightUnits: entry.heightUnits,
      stackingLip: entry.stackingLip,
      magnetHoles: entry.magnetHoles,
      dividerCountX: entry.dividerCountX,
      dividerCountY: entry.dividerCountY,
      perforatedBase: entry.perforatedBase,
      labelText: entry.labelText,
      labelIcon: entry.labelIcon,
    });
    const blob = meshToStlBlob(mesh);
    const name = `gridfinity_bin_${entry.gridX}x${entry.gridY}x${entry.heightUnits}.stl`;
    triggerDownload(blob, name);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'STL export failed.';
  } finally {
    downloadingId.value = null;
  }
}

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportJson(): void {
  const blob = new Blob([queue.exportJson()], { type: 'application/json' });
  triggerDownload(blob, 'gridfinity_print_plan.json');
}

// Import flow: pick a file, then ask whether to merge or replace.
const importDialogOpen = ref(false);
const pendingImportText = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

function openImportPicker(): void {
  fileInput.value?.click();
}

async function onImportFileChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  errorMessage.value = null;
  try {
    pendingImportText.value = await file.text();
    importDialogOpen.value = true;
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'Reading the file failed.';
  }
}

function finishImport(mode: 'merge' | 'replace'): void {
  importDialogOpen.value = false;
  if (pendingImportText.value === null) return;
  const problem = queue.importJson(pendingImportText.value, mode);
  pendingImportText.value = null;
  if (problem !== null) errorMessage.value = problem;
}

// Print session: multi-select queued entries, then mark the good ones printed.
const sessionActive = ref(false);
const sessionBannerVisible = ref(true);
const selectedIds = ref<Set<string>>(new Set());

function toggleSession(): void {
  sessionActive.value = !sessionActive.value;
  selectedIds.value = new Set();
  if (sessionActive.value) {
    exitBulkMode();
    filter.value = 'queued';
    sessionBannerVisible.value = true;
  }
}

function toggleSelected(entry: BinEntry): void {
  if (!sessionActive.value || entry.status !== 'queued') return;
  const next = new Set(selectedIds.value);
  if (next.has(entry.id)) next.delete(entry.id);
  else next.add(entry.id);
  selectedIds.value = next;
}

function markSelectedPrinted(): void {
  queue.markPrinted(selectedIds.value);
  sessionActive.value = false;
  selectedIds.value = new Set();
}

// Bulk selection: a second, independent mode for acting on many bins of any
// status at once. Mutually exclusive with the print session.
const bulkMode = ref(false);
const bulkSelectedIds = ref<Set<string>>(new Set());
const bulkDeleteConfirmOpen = ref(false);

function exitBulkMode(): void {
  bulkMode.value = false;
  bulkSelectedIds.value = new Set();
}

function toggleBulkMode(): void {
  if (bulkMode.value) {
    exitBulkMode();
    return;
  }
  if (sessionActive.value) {
    sessionActive.value = false;
    selectedIds.value = new Set();
  }
  bulkSelectedIds.value = new Set();
  bulkMode.value = true;
}

function toggleBulkSelected(entry: BinEntry): void {
  if (!bulkMode.value) return;
  const next = new Set(bulkSelectedIds.value);
  if (next.has(entry.id)) next.delete(entry.id);
  else next.add(entry.id);
  bulkSelectedIds.value = next;
}

const bulkSelectedEntries = computed(() =>
  queue.entries.filter((entry) => bulkSelectedIds.value.has(entry.id)),
);
const bulkHasQueued = computed(() =>
  bulkSelectedEntries.value.some((entry) => entry.status === 'queued'),
);
const bulkHasPrinted = computed(() =>
  bulkSelectedEntries.value.some((entry) => entry.status === 'printed'),
);

function bulkDuplicate(): void {
  for (const id of bulkSelectedIds.value) queue.duplicate(id);
  exitBulkMode();
}

function bulkRequeue(): void {
  queue.requeue(bulkSelectedIds.value);
  exitBulkMode();
}

function bulkMarkPrinted(): void {
  queue.markPrinted(bulkSelectedIds.value);
  exitBulkMode();
}

function bulkDelete(): void {
  bulkDeleteConfirmOpen.value = false;
  for (const id of bulkSelectedIds.value) queue.remove(id);
  exitBulkMode();
}

// Quick add: one click queues a saved template.
const quickAddSnackbar = ref(false);
const quickAddName = ref('');
const quickAddId = ref<string | null>(null);

function quickAdd(template: BinTemplate): void {
  quickAddId.value = queue.add({ ...template.params }, 1);
  quickAddName.value = template.name;
  quickAddSnackbar.value = true;
}

function editQuickAdded(): void {
  quickAddSnackbar.value = false;
  if (quickAddId.value !== null) app.openDesignerEdit(quickAddId.value);
}

// Manage templates: inline rename and delete.
const manageTemplatesOpen = ref(false);
const renamingTemplateId = ref<string | null>(null);
const renameText = ref('');

function startRename(template: BinTemplate): void {
  renamingTemplateId.value = template.id;
  renameText.value = template.name;
}

function commitRename(): void {
  if (renamingTemplateId.value === null) return;
  const name = renameText.value.trim();
  if (name !== '') templates.rename(renamingTemplateId.value, name);
  renamingTemplateId.value = null;
}

function templateSize(template: BinTemplate): string {
  return `${template.params.gridX} x ${template.params.gridY} x ${template.params.heightUnits}`;
}

// Keyboard shortcuts dispatched by the global listener in App.vue.
watch(
  () => app.shortcutIntent,
  (intent) => {
    if (intent === null) return;
    if (intent.kind === 'toggleSession') {
      if (queue.queuedCount > 0 || sessionActive.value) toggleSession();
    } else if (intent.kind === 'toggleBulk') {
      if (queue.entries.length > 0 || bulkMode.value) toggleBulkMode();
    } else if (intent.kind === 'escape') {
      // An open dialog consumes Escape itself; do not also cancel the mode.
      const dialogOpen =
        importDialogOpen.value ||
        bulkDeleteConfirmOpen.value ||
        manageTemplatesOpen.value ||
        app.shortcutSheetOpen;
      if (dialogOpen) return;
      if (bulkMode.value) exitBulkMode();
      else if (sessionActive.value) toggleSession();
    }
  },
);
</script>

<template>
  <v-container fluid class="queue-page">
    <v-toolbar density="comfortable" color="surface" flat rounded>
      <v-toolbar-title>
        Print queue
        <span class="text-body-2 text-medium-emphasis ml-2">
          {{ queue.queuedCount }} queued
        </span>
      </v-toolbar-title>
      <v-spacer />
      <v-btn
        v-if="!smAndDown"
        color="primary"
        variant="flat"
        prepend-icon="mdi-plus"
        class="mr-1"
        @click="app.openDesignerNew()"
      >
        Add bin
        <v-tooltip activator="parent" location="bottom">Add bin (Ctrl+N)</v-tooltip>
      </v-btn>
      <v-btn icon variant="text" @click="app.shortcutSheetOpen = true">
        <v-icon icon="mdi-help-circle-outline" />
        <v-tooltip activator="parent" location="bottom">Keyboard shortcuts (?)</v-tooltip>
      </v-btn>
      <v-menu>
        <template #activator="{ props: menuProps }">
          <v-btn icon variant="text" v-bind="menuProps">
            <v-icon icon="mdi-dots-vertical" />
            <v-tooltip activator="parent" location="bottom">More actions</v-tooltip>
          </v-btn>
        </template>
        <v-list density="comfortable">
          <v-list-item
            prepend-icon="mdi-printer-3d"
            :disabled="queue.queuedCount === 0 && !sessionActive"
            :title="sessionActive ? 'Cancel session' : 'Start print session'"
            @click="toggleSession"
          />
          <v-list-item
            prepend-icon="mdi-checkbox-multiple-marked-outline"
            :disabled="queue.entries.length === 0 && !bulkMode"
            :title="bulkMode ? 'Cancel selection' : 'Select bins'"
            @click="toggleBulkMode"
          />
          <v-list-item
            prepend-icon="mdi-format-list-bulleted-square"
            title="Add from screw list"
            @click="app.showScrewListImport()"
          />
          <v-divider />
          <v-list-item
            prepend-icon="mdi-view-grid-outline"
            title="Manage templates"
            @click="manageTemplatesOpen = true"
          />
          <v-list-item
            prepend-icon="mdi-download"
            title="Export JSON"
            @click="exportJson"
          />
          <v-list-item
            prepend-icon="mdi-upload"
            title="Import JSON"
            @click="openImportPicker"
          />
        </v-list>
      </v-menu>
    </v-toolbar>

    <div v-if="templates.templates.length > 0" class="mt-2 mb-1">
      <div class="text-caption text-medium-emphasis">Quick add</div>
      <v-chip-group column>
        <v-chip
          v-for="template in templates.templates"
          :key="template.id"
          prepend-icon="mdi-plus"
          @click="quickAdd(template)"
        >
          {{ template.name }}
        </v-chip>
      </v-chip-group>
    </div>

    <v-tabs
      v-if="!sessionActive"
      v-model="filter"
      color="primary"
      density="comfortable"
      show-arrows
      class="mb-2"
    >
      <v-tab value="all">
        All
        <v-chip size="x-small" variant="text" class="ml-1">{{ queue.entries.length }}</v-chip>
      </v-tab>
      <v-tab value="queued">
        Queued
        <v-chip size="x-small" variant="text" class="ml-1">{{ queue.queuedCount }}</v-chip>
      </v-tab>
      <v-tab value="printed">
        Printed
        <v-chip size="x-small" variant="text" class="ml-1">{{ queue.printedCount }}</v-chip>
      </v-tab>
    </v-tabs>

    <input
      ref="fileInput"
      type="file"
      accept="application/json,.json"
      style="display: none"
      @change="onImportFileChosen"
    />

    <v-alert
      v-if="sessionActive"
      v-model="sessionBannerVisible"
      type="info"
      variant="tonal"
      density="comfortable"
      closable
      class="mb-4"
    >
      Select the queued bins that printed successfully, then mark them as printed.
      Bins you leave unselected stay in the queue.
    </v-alert>

    <v-alert v-if="errorMessage" type="error" density="compact" class="mb-4">
      {{ errorMessage }}
    </v-alert>

    <v-empty-state
      v-if="queue.entries.length === 0"
      icon="mdi-cube-outline"
      title="No bins yet"
      text="Design a bin, add it to the print plan, then download its STL when you're ready to print."
    >
      <template #actions>
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-plus"
          @click="app.openDesignerNew()"
        >
          Add your first bin
        </v-btn>
      </template>
    </v-empty-state>

    <p
      v-else-if="filteredEntries.length === 0"
      class="text-body-1 text-medium-emphasis text-center py-8"
    >
      No bins match this filter.
    </p>

    <v-row v-else>
      <v-col
        v-for="entry in filteredEntries"
        :key="entry.id"
        cols="12"
        sm="6"
        md="4"
      >
        <v-card
          :variant="
            (sessionActive && selectedIds.has(entry.id)) ||
            (bulkMode && bulkSelectedIds.has(entry.id))
              ? 'tonal'
              : 'outlined'
          "
          :color="
            (sessionActive && selectedIds.has(entry.id)) ||
            (bulkMode && bulkSelectedIds.has(entry.id))
              ? 'primary'
              : undefined
          "
          :class="{ 'card-dimmed': sessionActive && entry.status !== 'queued' }"
          v-on="
            bulkMode
              ? { click: () => toggleBulkSelected(entry) }
              : sessionActive && entry.status === 'queued'
                ? { click: () => toggleSelected(entry) }
                : {}
          "
        >
          <v-card-item>
            <template #prepend>
              <v-checkbox-btn
                v-if="bulkMode"
                :model-value="bulkSelectedIds.has(entry.id)"
                class="mr-1 flex-grow-0"
                @click.stop="toggleBulkSelected(entry)"
              />
              <FootprintThumb
                class="mr-1"
                :grid-x="entry.gridX"
                :grid-y="entry.gridY"
                :label-icon="entry.labelIcon"
              />
            </template>
            <v-card-title>{{ cardTitle(entry) }}</v-card-title>
            <v-card-subtitle v-if="entry.labelText !== ''">
              {{ sizeLabel(entry) }}
            </v-card-subtitle>
            <template #append>
              <v-icon
                v-if="sessionActive && selectedIds.has(entry.id)"
                icon="mdi-check-circle"
                color="primary"
              />
              <v-chip
                v-else
                size="small"
                variant="tonal"
                :color="entry.status === 'printed' ? 'success' : 'primary'"
              >
                {{ entry.status }}
              </v-chip>
            </template>
          </v-card-item>
          <v-divider />
          <v-card-text class="py-2 d-flex align-center flex-wrap ga-1">
            <v-chip v-if="entry.labelIcon !== null" size="small" variant="text">
              <template #prepend>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 100 100"
                  class="mr-1"
                  aria-hidden="true"
                >
                  <path :d="labelIconPath(entry.labelIcon)" fill="currentColor" fill-rule="evenodd" />
                </svg>
              </template>
              {{ entry.labelIcon }}
            </v-chip>
            <v-chip
              v-if="entry.dividerCountX > 0 || entry.dividerCountY > 0"
              size="small"
              variant="text"
              prepend-icon="mdi-view-grid-plus-outline"
            >
              {{ entry.dividerCountX }}x{{ entry.dividerCountY }}
            </v-chip>
            <v-chip size="small" variant="outlined" prepend-icon="mdi-close">
              {{ entry.quantity }}
            </v-chip>
          </v-card-text>
          <v-card-actions v-if="!sessionActive" class="justify-end" @click.stop>
            <v-btn
              variant="text"
              size="small"
              prepend-icon="mdi-file-download-outline"
              :loading="downloadingId === entry.id"
              :disabled="downloadingId !== null"
              @click="downloadStl(entry)"
            >
              Download
            </v-btn>
            <v-btn
              v-if="entry.status === 'queued'"
              variant="tonal"
              size="small"
              color="primary"
              @click="queue.markPrinted([entry.id])"
            >
              Mark printed
            </v-btn>
            <v-btn
              v-else
              variant="tonal"
              size="small"
              color="success"
              @click="queue.requeue([entry.id])"
            >
              Back to queue
            </v-btn>
            <v-menu>
              <template #activator="{ props: menuProps }">
                <v-btn icon variant="text" size="small" v-bind="menuProps" @click.stop>
                  <v-icon icon="mdi-dots-vertical" />
                  <v-tooltip activator="parent" location="bottom">More actions</v-tooltip>
                </v-btn>
              </template>
              <v-list density="comfortable">
                <v-list-item
                  prepend-icon="mdi-pencil"
                  title="Edit"
                  @click="app.openDesignerEdit(entry.id)"
                />
                <v-list-item
                  prepend-icon="mdi-content-copy"
                  title="Duplicate"
                  @click="queue.duplicate(entry.id)"
                />
                <v-list-item
                  prepend-icon="mdi-delete-outline"
                  base-color="error"
                  title="Delete"
                  @click="queue.remove(entry.id)"
                />
              </v-list>
            </v-menu>
          </v-card-actions>
        </v-card>
      </v-col>
    </v-row>

    <div v-if="bulkMode" class="session-bar d-flex align-center flex-wrap py-3 px-2">
      <span class="text-body-1 mr-4">
        {{ bulkSelectedIds.size }} selected
      </span>
      <v-spacer />
      <v-btn variant="text" @click="exitBulkMode">Cancel</v-btn>
      <v-btn
        variant="text"
        :disabled="bulkSelectedIds.size === 0"
        @click="bulkDuplicate"
      >
        Duplicate
      </v-btn>
      <v-btn variant="text" :disabled="!bulkHasPrinted" @click="bulkRequeue">
        Requeue
      </v-btn>
      <v-btn variant="text" :disabled="!bulkHasQueued" @click="bulkMarkPrinted">
        Mark printed
      </v-btn>
      <v-btn
        variant="text"
        color="error"
        :disabled="bulkSelectedIds.size === 0"
        @click="bulkDeleteConfirmOpen = true"
      >
        Delete
      </v-btn>
    </div>

    <div v-if="sessionActive" class="session-bar d-flex align-center py-3 px-2">
      <span class="text-body-1 mr-4">
        {{ selectedIds.size }} selected
      </span>
      <v-spacer />
      <v-btn variant="text" @click="toggleSession">Cancel</v-btn>
      <v-btn
        color="primary"
        variant="flat"
        class="ml-2"
        :disabled="selectedIds.size === 0"
        @click="markSelectedPrinted"
      >
        Mark {{ selectedIds.size }} selected as printed
      </v-btn>
    </div>

    <v-fab
      v-if="smAndDown"
      color="primary"
      icon
      location="bottom end"
      app
      appear
      @click="app.openDesignerNew()"
    >
      <v-icon icon="mdi-plus" />
      <v-tooltip activator="parent" location="start">Add bin</v-tooltip>
    </v-fab>

    <v-dialog v-model="importDialogOpen" max-width="480">
      <v-card>
        <v-card-title>Import plan</v-card-title>
        <v-card-text>
          Merge keeps your current entries and updates any entry that appears in
          the file with the same id. Replace discards the current plan and loads
          the file as the whole plan.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="importDialogOpen = false">Cancel</v-btn>
          <v-btn color="primary" variant="text" @click="finishImport('merge')">Merge</v-btn>
          <v-btn color="primary" variant="flat" @click="finishImport('replace')">Replace</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="bulkDeleteConfirmOpen" max-width="400">
      <v-card>
        <v-card-title>Delete bins</v-card-title>
        <v-card-text>
          Delete {{ bulkSelectedIds.size }}
          {{ bulkSelectedIds.size === 1 ? 'bin' : 'bins' }}? This cannot be undone.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="bulkDeleteConfirmOpen = false">Cancel</v-btn>
          <v-btn color="error" variant="flat" @click="bulkDelete">Delete</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="manageTemplatesOpen" max-width="520">
      <v-card>
        <v-card-title>Manage templates</v-card-title>
        <v-card-text v-if="templates.templates.length === 0">
          You haven't saved any bin templates yet. Save one from the bin
          designer to reuse it here.
        </v-card-text>
        <v-list v-else density="comfortable">
          <v-list-item v-for="template in templates.templates" :key="template.id">
            <template #prepend>
              <FootprintThumb
                class="mr-3"
                :grid-x="template.params.gridX"
                :grid-y="template.params.gridY"
                :label-icon="template.params.labelIcon"
              />
            </template>
            <v-text-field
              v-if="renamingTemplateId === template.id"
              v-model="renameText"
              density="compact"
              hide-details
              autofocus
              @blur="commitRename"
              @keydown.enter.prevent="commitRename"
            />
            <template v-else>
              <v-list-item-title
                class="template-name"
                @click="startRename(template)"
              >
                {{ template.name }}
              </v-list-item-title>
              <v-list-item-subtitle>{{ templateSize(template) }}</v-list-item-subtitle>
            </template>
            <template #append>
              <v-btn
                icon
                variant="text"
                size="small"
                @click="templates.remove(template.id)"
              >
                <v-icon icon="mdi-delete-outline" />
                <v-tooltip activator="parent" location="bottom">Delete</v-tooltip>
              </v-btn>
            </template>
          </v-list-item>
        </v-list>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="manageTemplatesOpen = false">Close</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="quickAddSnackbar" timeout="4000">
      Added {{ quickAddName }} to the queue.
      <template #actions>
        <v-btn variant="text" color="primary" @click="editQuickAdded">Edit</v-btn>
      </template>
    </v-snackbar>
  </v-container>
</template>

<style scoped>
.queue-page {
  max-width: 1100px;
}

.template-name {
  cursor: pointer;
}

.card-dimmed {
  opacity: 0.6;
}

.session-bar {
  position: sticky;
  bottom: 0;
  background: rgb(var(--v-theme-surface));
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.12);
}
</style>
