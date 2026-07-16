<script setup lang="ts">
import { computed, ref } from 'vue';
import { LABEL_ICONS, type LabelIcon } from '../engine/label/icons';
import { validateCustomIcon } from '../engine/label/customIcon';
import { useCustomIcons } from '../stores/customIcons';

/**
 * Inline label icon swatch panel: category tabs over a grid of icon tiles,
 * plus the custom SVG upload flow on the Custom tab. v-model is the icon
 * name or null for no icon.
 */

const model = defineModel<string | null>({ required: true });

const customIcons = useCustomIcons();
const iconTab = ref<'fasteners' | 'general' | 'custom'>('fasteners');

const iconsByCategory = computed<Record<'fasteners' | 'general' | 'custom', LabelIcon[]>>(
  () => ({
    fasteners: LABEL_ICONS.filter((icon) => icon.category === 'fasteners'),
    general: LABEL_ICONS.filter((icon) => icon.category === 'general'),
    custom: customIcons.icons.map((icon) => ({
      name: icon.name,
      path: icon.path,
      viewBox: icon.viewBox,
      category: 'custom' as const,
    })),
  }),
);

// Custom icon upload: paste or upload an SVG, validate it, then save it
// under a name. Validation runs live on the pasted text.
const customIconInput = ref('');
const customIconName = ref('');
const svgFileInput = ref<HTMLInputElement | null>(null);

const customIconValidation = computed(() =>
  customIconInput.value.trim() === '' ? null : validateCustomIcon(customIconInput.value),
);

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
  customIconInput.value = '';
  customIconName.value = '';
  model.value = name;
}
</script>

<template>
  <div>
    <v-tabs v-model="iconTab" density="compact">
      <v-tab value="fasteners">Fasteners</v-tab>
      <v-tab value="general">General</v-tab>
      <v-tab value="custom">Custom</v-tab>
    </v-tabs>
    <div class="d-flex flex-wrap ga-1 mt-2">
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
      <v-btn
        v-for="icon in iconsByCategory[iconTab]"
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
    </div>
    <template v-if="iconTab === 'custom'">
      <v-textarea
        v-model="customIconInput"
        label="Paste SVG path data or a full <svg>"
        rows="3"
        density="compact"
        class="mt-3"
        hint="Paste path data (the d attribute) or a full SVG with exactly one filled shape. The icon is embossed on the label shelf the same size as the built-in icons, so keep it simple and bold."
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
        <v-btn
          color="primary"
          variant="tonal"
          size="small"
          :disabled="!canAddCustomIcon"
          @click="addCustomIcon"
        >
          Add to my icons
        </v-btn>
      </template>
    </template>
  </div>
</template>

<style scoped>
.icon-tile {
  min-width: 40px;
  width: 40px;
  height: 40px;
  padding: 0;
}
</style>
