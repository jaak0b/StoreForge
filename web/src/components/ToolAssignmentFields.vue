<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useToolAssignment } from '../stores/toolAssignment';
import { MAX_TOOL, MIN_TOOL } from '../engine/threeMf/toolAssignment';

/**
 * The base and label filament slot fields shown beside every two-filament
 * 3MF download. Both edit the shared tool assignment store, so every download
 * place shows the same values. Clicks and keys are kept inside the fields so a
 * host menu neither closes nor moves its keyboard focus while typing.
 */

const tools = useToolAssignment();
const { bodyText, labelText } = storeToRefs(tools);
</script>

<template>
  <div class="tool-fields px-4 py-2" @click.stop @keydown.stop>
    <div class="d-flex ga-2">
      <v-text-field
        v-model="bodyText"
        label="Base tool"
        type="number"
        :min="MIN_TOOL"
        :max="MAX_TOOL"
        step="1"
        density="compact"
        variant="outlined"
        :error-messages="tools.body.ok ? [] : [tools.body.error]"
      />
      <v-text-field
        v-model="labelText"
        label="Label tool"
        type="number"
        :min="MIN_TOOL"
        :max="MAX_TOOL"
        step="1"
        density="compact"
        variant="outlined"
        :error-messages="tools.label.ok ? [] : [tools.label.error]"
      />
    </div>
    <p class="text-caption text-medium-emphasis">
      These are the Orca Slicer filament slots the base and the raised label text print with.
    </p>
  </div>
</template>

<style scoped>
.tool-fields {
  max-width: 320px;
}
</style>
