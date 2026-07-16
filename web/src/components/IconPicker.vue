<script setup lang="ts">
import { computed, ref } from 'vue';
import { LABEL_ICONS, type LabelIcon } from '../engine/label/icons';
import { validateCustomIcon } from '../engine/label/customIcon';
import { useCustomIcons } from '../stores/customIcons';

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
// save it under a name.
const uploadOpen = ref(false);
const customIconInput = ref('');
const customIconName = ref('');
const svgFileInput = ref<HTMLInputElement | null>(null);

const customIconValidation = computed(() =>
  customIconInput.value.trim() === '' ? null : validateCustomIcon(customIconInput.value),
);

function openUpload(): void {
  customIconInput.value = '';
  customIconName.value = '';
  uploadOpen.value = true;
}

function openSvgPicker(): void {
  svgFileInput.value?.click();
}

async function onSvgFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  customIconInput.value = await file.text();
  if (customIconName.value === '') {
    customIconName.value = file.name.replace(/\.svg$/i, '');
  }
}

const customIconNameTaken = computed(() => {
  const name = customIconName.value.trim();
  if (name === '') return false;
  return (
    LABEL_ICONS.some((icon) => icon.name === name) ||
    customIcons.iconByName(name) !== null
  );
});

const canAddCustomIcon = computed(
  () =>
    customIconValidation.value?.ok === true &&
    customIconName.value.trim() !== '' &&
    !customIconNameTaken.value,
);

function addCustomIcon(): void {
  const validation = customIconValidation.value;
  if (validation === null || !validation.ok || !canAddCustomIcon.value) return;
  const name = customIconName.value.trim();
  customIcons.add(name, validation.path, validation.viewBox);
  model.value = name;
  uploadOpen.value = false;
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
        <v-btn
          v-for="icon in group"
          :key="icon.name"
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
      </template>
      <v-btn variant="outlined" size="small" class="icon-tile" @click="openUpload">
        <v-icon icon="mdi-plus" size="18" />
        <v-tooltip activator="parent" location="bottom">Add a custom icon</v-tooltip>
      </v-btn>
    </div>

    <v-dialog v-model="uploadOpen" max-width="480">
      <v-card>
        <v-card-title>Add a custom icon</v-card-title>
        <v-card-text>
          <v-textarea
            v-model="customIconInput"
            label="SVG path data or a full <svg>"
            rows="3"
            density="compact"
            hint="Use one filled shape; keep it simple and bold."
            persistent-hint
          />
          <input
            ref="svgFileInput"
            type="file"
            accept=".svg,image/svg+xml"
            class="d-none"
            @change="onSvgFilePicked"
          />
          <v-btn
            variant="text"
            size="small"
            prepend-icon="mdi-upload-outline"
            class="mt-2"
            @click="openSvgPicker"
          >
            Upload SVG file
          </v-btn>
          <v-alert
            v-if="customIconValidation !== null && !customIconValidation.ok"
            type="warning"
            density="compact"
            variant="tonal"
            class="mt-2"
          >
            {{ customIconValidation.error }}
          </v-alert>
          <template v-if="customIconValidation !== null && customIconValidation.ok">
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
              :error-messages="
                customIconNameTaken ? ['An icon with this name already exists.'] : []
              "
              @keydown.enter.prevent="addCustomIcon"
            />
          </template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="uploadOpen = false">Cancel</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :disabled="!canAddCustomIcon"
            @click="addCustomIcon"
          >
            Add to my icons
          </v-btn>
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

.group-divider {
  width: 1px;
  height: 28px;
  background: rgba(var(--v-theme-on-surface), 0.16);
  margin: 0 4px;
}
</style>
