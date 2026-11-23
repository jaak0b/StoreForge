<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { LABEL_ICONS, type LabelIcon } from '../engine/label/icons';
import type { CustomIconValidation } from '../engine/label/customIcon';
import { useCustomIcons, validateIconSource } from '../stores/customIcons';

/**
 * Label icon picker: one flat wrap-grid of icon tiles ("No icon" first, then
 * fasteners, general and custom icons separated by thin dividers), ending in
 * a "+" tile that opens the custom SVG upload dialog. v-model is the icon
 * name or null for no icon.
 */

const model = defineModel<string | null>({ required: true });

const customIcons = useCustomIcons();

const fastenerIcons = computed(() =>
  LABEL_ICONS.filter((icon) => icon.category === 'fasteners'),
);
const generalIcons = computed(() =>
  LABEL_ICONS.filter((icon) => icon.category === 'general'),
);
const userIcons = computed<LabelIcon[]>(() =>
  customIcons.icons.map((icon) => ({
    name: icon.name,
    path: icon.path,
    viewBox: icon.viewBox,
    category: 'custom' as const,
  })),
);

// Custom icon upload dialog: paste or upload an SVG, validate it live, then
// save it under a name. Picking several files at once switches the dialog to a
// list with one row per file instead.
const uploadOpen = ref(false);
const customIconInput = ref('');
const customIconName = ref('');
const svgFileInput = ref<HTMLInputElement | null>(null);
const adding = ref(false);

// Validation runs in the worker (its union and stroke expansion need the
// manifold WASM), so it is async: each input change starts a validation and a
// later change supersedes an earlier one still in flight.
const customIconValidation = ref<CustomIconValidation | null>(null);
const validating = ref(false);
/** Why saving the pasted icon failed, when the save itself refused it. */
const addError = ref<string | null>(null);
let validationToken = 0;

async function validateInput(value: string, token: number): Promise<void> {
  const result = await validateIconSource(value);
  if (token !== validationToken) return;
  customIconValidation.value = result;
  validating.value = false;
}

watch(customIconInput, (value) => {
  const token = ++validationToken;
  addError.value = null;
  if (value.trim() === '') {
    customIconValidation.value = null;
    validating.value = false;
    return;
  }
  validating.value = true;
  void validateInput(value, token);
});

watch(customIconName, () => {
  addError.value = null;
});

/** One file of a multi-file pick: its source, editable name and validation. */
interface BatchRow {
  key: number;
  fileName: string;
  source: string;
  name: string;
  validation: CustomIconValidation | null;
  /** Bumped when a validation starts, so only the latest result is kept. */
  token: number;
  /** Why saving this row failed, when the save itself refused it. */
  addError: string | null;
}

const batchRows = ref<BatchRow[]>([]);
let nextRowKey = 0;

const DUPLICATE_IN_BATCH_PROBLEM =
  'Another file in this list has the same name. Rename one of them.';

async function validateRow(row: BatchRow): Promise<void> {
  const token = ++row.token;
  row.validation = null;
  const result = await validateIconSource(row.source);
  if (token !== row.token) return;
  row.validation = result;
}

/** The problem shown on a row, or null when it has none. */
function rowProblem(row: BatchRow): string | null {
  if (row.validation !== null && !row.validation.ok) return row.validation.error;
  const nameProblem = customIcons.nameProblem(row.name);
  if (nameProblem !== null) return nameProblem;
  const trimmed = row.name.trim();
  const sameName = batchRows.value.filter((other) => other.name.trim() === trimmed).length;
  if (sameName > 1) return DUPLICATE_IN_BATCH_PROBLEM;
  return row.addError;
}

function rowReady(row: BatchRow): boolean {
  return row.validation !== null && row.validation.ok && rowProblem(row) === null;
}

const readyRowCount = computed(() => batchRows.value.filter(rowReady).length);

function renameRow(row: BatchRow, name: string): void {
  row.name = name;
  row.addError = null;
}

function iconNameOfFile(file: File): string {
  return file.name.replace(/\.svg$/i, '');
}

function openUpload(): void {
  customIconInput.value = '';
  customIconName.value = '';
  customIconValidation.value = null;
  validating.value = false;
  addError.value = null;
  validationToken++;
  batchRows.value = [];
  uploadOpen.value = true;
}

function openSvgPicker(): void {
  svgFileInput.value?.click();
}

async function onSvgFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  if (files.length === 0) return;
  if (files.length === 1) {
    const file = files[0];
    batchRows.value = [];
    customIconInput.value = await file.text();
    if (customIconName.value === '') customIconName.value = iconNameOfFile(file);
    return;
  }
  const rows: BatchRow[] = [];
  for (const file of files) {
    rows.push({
      key: nextRowKey++,
      fileName: file.name,
      source: await file.text(),
      name: iconNameOfFile(file),
      validation: null,
      token: 0,
      addError: null,
    });
  }
  batchRows.value = rows;
  // Validate through the reactive proxies so each result updates its row.
  for (const row of batchRows.value) void validateRow(row);
}

const customIconNameProblem = computed(() =>
  customIconName.value.trim() === '' ? null : customIcons.nameProblem(customIconName.value),
);

const canAddCustomIcon = computed(
  () =>
    !validating.value &&
    !adding.value &&
    customIconValidation.value?.ok === true &&
    customIcons.nameProblem(customIconName.value) === null,
);

async function addCustomIcon(): Promise<void> {
  if (!canAddCustomIcon.value) return;
  adding.value = true;
  const name = customIconName.value.trim();
  const result = await customIcons.importIcon(name, customIconInput.value);
  adding.value = false;
  if (!result.ok) {
    addError.value = result.error;
    return;
  }
  model.value = name;
  uploadOpen.value = false;
}

/**
 * Adds every row that passes, one after another, so each saved name is taken
 * before the next row is saved. Rows that fail stay in the list with their
 * reason; the dialog closes once the list is empty.
 */
async function addAllValidIcons(): Promise<void> {
  if (adding.value) return;
  adding.value = true;
  for (const row of batchRows.value.filter(rowReady)) {
    const result = await customIcons.importIcon(row.name, row.source);
    if (result.ok) {
      batchRows.value = batchRows.value.filter((other) => other.key !== row.key);
    } else {
      row.addError = result.error;
    }
  }
  adding.value = false;
  if (batchRows.value.length === 0) uploadOpen.value = false;
}

// Removing a custom icon: a confirm dialog holds the icon being removed. When
// the removed icon is the one selected here, the selection clears so the
// designer stops referencing an icon that no longer exists.
const removeTarget = ref<{ name: string } | null>(null);
/** Why the removal was refused, for example when the icon is already gone. */
const removeError = ref<string | null>(null);

function askRemove(icon: LabelIcon): void {
  removeError.value = null;
  removeTarget.value = { name: icon.name };
}

function confirmRemove(): void {
  const target = removeTarget.value;
  if (target === null) return;
  const problem = customIcons.removeByName(target.name);
  if (problem !== null) {
    removeError.value = problem;
    return;
  }
  if (model.value === target.name) model.value = null;
  removeTarget.value = null;
}
</script>

<template>
  <div>
    <div class="d-flex flex-wrap align-center ga-1">
      <v-btn
        variant="outlined"
        size="small"
        class="icon-tile"
        :color="model === null ? 'primary' : undefined"
        @click="model = null"
      >
        <v-icon icon="mdi-close" size="18" />
        <v-tooltip activator="parent" location="bottom">No icon</v-tooltip>
      </v-btn>
      <template
        v-for="group in [fastenerIcons, generalIcons, userIcons].filter(
          (icons) => icons.length > 0,
        )"
        :key="group[0].category"
      >
        <span class="group-divider" aria-hidden="true" />
        <span
          v-for="icon in group"
          :key="icon.name"
          class="icon-tile-wrap"
          :class="{ 'icon-tile-wrap--removable': icon.category === 'custom' }"
        >
          <v-btn
            variant="outlined"
            size="small"
            class="icon-tile"
            :color="model === icon.name ? 'primary' : undefined"
            @click="model = icon.name"
          >
            <svg width="24" height="24" :viewBox="icon.viewBox.join(' ')" aria-hidden="true">
              <path :d="icon.path" fill="currentColor" fill-rule="evenodd" />
            </svg>
            <v-tooltip activator="parent" location="bottom">{{ icon.name }}</v-tooltip>
          </v-btn>
          <v-btn
            v-if="icon.category === 'custom'"
            icon="mdi-close"
            size="x-small"
            variant="flat"
            color="surface-variant"
            class="icon-remove"
            :aria-label="`Remove the ${icon.name} icon`"
            @click.stop="askRemove(icon)"
          />
        </span>
      </template>
      <v-btn variant="outlined" size="small" class="icon-tile" @click="openUpload">
        <v-icon icon="mdi-plus" size="18" />
        <v-tooltip activator="parent" location="bottom">Add a custom icon</v-tooltip>
      </v-btn>
    </div>

    <v-dialog v-model="uploadOpen" :max-width="batchRows.length > 0 ? 600 : 480">
      <v-card>
        <v-card-title>Add a custom icon</v-card-title>
        <v-card-text>
          <input
            ref="svgFileInput"
            type="file"
            accept=".svg,image/svg+xml"
            multiple
            class="d-none"
            @change="onSvgFilePicked"
          />
          <template v-if="batchRows.length === 0">
            <v-textarea
              v-model="customIconInput"
              label="SVG code, path data, or link to an .svg file"
              rows="3"
              density="compact"
              hint="Paste path data or a whole SVG, or paste a link to an .svg file and it will be fetched for you. Filled shapes and stroked outlines are merged into one silhouette, so most icons work as they are."
              persistent-hint
            />
            <v-btn
              variant="text"
              size="small"
              prepend-icon="mdi-upload-outline"
              class="mt-2"
              @click="openSvgPicker"
            >
              Upload SVG files
            </v-btn>
            <div v-if="validating" class="d-flex align-center ga-2 mt-2">
              <v-progress-circular indeterminate size="20" width="2" />
              <span class="text-body-2">Checking this shape.</span>
            </div>
            <v-alert
              v-if="!validating && customIconValidation !== null && !customIconValidation.ok"
              type="warning"
              density="compact"
              variant="tonal"
              class="mt-2"
            >
              {{ customIconValidation.error }}
            </v-alert>
            <template v-if="!validating && customIconValidation !== null && customIconValidation.ok">
              <div class="d-flex align-center ga-2 mt-2">
                <v-icon icon="mdi-check-circle" color="success" size="20" />
                <svg
                  width="24"
                  height="24"
                  :viewBox="customIconValidation.viewBox.join(' ')"
                  aria-hidden="true"
                >
                  <path
                    :d="customIconValidation.path"
                    fill="currentColor"
                    fill-rule="evenodd"
                  />
                </svg>
                <span class="text-body-2">This shape can be embossed.</span>
              </div>
              <v-text-field
                v-model="customIconName"
                label="Icon name"
                density="compact"
                class="mt-2"
                :error-messages="customIconNameProblem !== null ? [customIconNameProblem] : []"
                @keydown.enter.prevent="addCustomIcon"
              />
            </template>
            <v-alert
              v-if="addError !== null"
              type="warning"
              density="compact"
              variant="tonal"
              class="mt-2"
            >
              {{ addError }}
            </v-alert>
          </template>
          <template v-else>
            <p class="text-body-2 mb-3">
              Each file becomes one icon. Rename any file marked with a problem, then add the valid
              icons.
            </p>
            <div
              v-for="row in batchRows"
              :key="row.key"
              class="d-flex align-start ga-3 mb-2"
            >
              <div class="batch-status d-flex align-center justify-center">
                <v-progress-circular
                  v-if="row.validation === null"
                  indeterminate
                  size="20"
                  width="2"
                />
                <svg
                  v-else-if="row.validation.ok"
                  width="28"
                  height="28"
                  :viewBox="row.validation.viewBox.join(' ')"
                  aria-hidden="true"
                >
                  <path :d="row.validation.path" fill="currentColor" fill-rule="evenodd" />
                </svg>
                <v-icon v-else icon="mdi-alert" color="warning" size="20" />
              </div>
              <v-text-field
                :model-value="row.name"
                :label="`Icon name for ${row.fileName}`"
                density="compact"
                :hint="row.validation === null ? 'Checking this shape.' : undefined"
                :persistent-hint="row.validation === null"
                :error-messages="rowProblem(row) !== null ? [rowProblem(row) as string] : []"
                @update:model-value="renameRow(row, $event)"
              />
            </div>
            <v-btn
              variant="text"
              size="small"
              prepend-icon="mdi-upload-outline"
              @click="openSvgPicker"
            >
              Pick other SVG files
            </v-btn>
          </template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="uploadOpen = false">Cancel</v-btn>
          <v-btn
            v-if="batchRows.length === 0"
            color="primary"
            variant="flat"
            :disabled="!canAddCustomIcon"
            @click="addCustomIcon"
          >
            Add to my icons
          </v-btn>
          <v-btn
            v-else
            color="primary"
            variant="flat"
            :disabled="adding || readyRowCount === 0"
            @click="addAllValidIcons"
          >
            Add all valid icons
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="removeTarget !== null" max-width="360" @update:model-value="removeTarget = null">
      <v-card>
        <v-card-title>Remove this icon</v-card-title>
        <v-card-text>
          Remove the {{ removeTarget?.name }} icon from your icons? Any queued bins that
          still use it will print without an icon on the label.
          <v-alert
            v-if="removeError !== null"
            type="warning"
            density="compact"
            variant="tonal"
            class="mt-2"
          >
            {{ removeError }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="removeTarget = null">Cancel</v-btn>
          <v-btn color="error" variant="flat" @click="confirmRemove">Remove</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.icon-tile {
  min-width: 40px;
  width: 40px;
  height: 40px;
  padding: 0;
}

.icon-tile-wrap {
  position: relative;
  display: inline-flex;
}

.icon-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  opacity: 0;
  transition: opacity 0.12s ease;
  pointer-events: none;
}

.icon-tile-wrap--removable:hover .icon-remove,
.icon-tile-wrap--removable:focus-within .icon-remove {
  opacity: 1;
  pointer-events: auto;
}

.batch-status {
  width: 32px;
  height: 40px;
  flex: none;
}

.group-divider {
  width: 1px;
  height: 28px;
  background: rgba(var(--v-theme-on-surface), 0.16);
  margin: 0 4px;
}
</style>
