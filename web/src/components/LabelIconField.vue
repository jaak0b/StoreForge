<script setup lang="ts">
import { computed, ref } from 'vue';
import { useCustomIcons } from '../stores/customIcons';
import { LABEL_ICONS } from '../engine/label/icons';
import IconPicker from './IconPicker.vue';

/**
 * The shared label row of the add-bin card: a compact icon button that opens
 * the icon grid in a popover, next to the label text field. Used by the
 * Manual bin tab and the Tool trace drawer's Bin tab so the label and icon
 * controls look and behave the same everywhere.
 */

/** The label text, bound to the owning store's field. */
const text = defineModel<string>('text', { required: true });
/** The selected icon name, or null for no icon. */
const icon = defineModel<string | null>('icon', { required: true });

const customIcons = useCustomIcons();

/** The current icon's drawable shape, from the shared icon sources. */
const currentIcon = computed(() => {
  if (icon.value === null) return null;
  return (
    LABEL_ICONS.find((entry) => entry.name === icon.value) ??
    customIcons.iconByName(icon.value) ??
    null
  );
});

const menuOpen = ref(false);
</script>

<template>
  <div class="d-flex align-start ga-2">
    <v-menu v-model="menuOpen" :close-on-content-click="false" location="bottom start">
      <template #activator="{ props: menuProps }">
        <v-btn variant="outlined" class="icon-thumb" v-bind="menuProps">
          <svg
            v-if="currentIcon !== null"
            width="26"
            height="26"
            :viewBox="currentIcon.viewBox.join(' ')"
            aria-hidden="true"
          >
            <path :d="currentIcon.path" fill="currentColor" fill-rule="evenodd" />
          </svg>
          <v-icon v-else icon="mdi-close" size="20" />
          <v-tooltip activator="parent" location="bottom">
            {{ currentIcon !== null ? currentIcon.name : 'No icon' }}; press to pick another.
          </v-tooltip>
        </v-btn>
      </template>
      <v-card class="pa-3 icon-menu">
        <IconPicker v-model="icon" />
      </v-card>
    </v-menu>
    <v-text-field
      v-model="text"
      label="Label"
      placeholder="What's inside?"
      density="comfortable"
      class="flex-grow-1"
      hint="Printed on the label; long text shrinks to fit."
    />
  </div>
</template>

<style scoped>
/*
 * Matches the 48 px input box of the comfortable-density text field beside
 * it; with the row aligned to flex-start both boxes share the same top and
 * centre while the field's message area hangs below.
 */
.icon-thumb {
  min-width: 48px;
  width: 48px;
  height: 48px;
  padding: 0;
}

.icon-menu {
  max-width: 380px;
}
</style>
