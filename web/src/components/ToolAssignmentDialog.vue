<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useToolAssignment } from '../stores/toolAssignment';
import { MAX_TOOL, MIN_TOOL } from '../engine/threeMf/toolAssignment';

/**
 * The app's one tool dialog for two-filament 3MF downloads, mounted once in
 * App.vue. It edits the shared tool assignment store and settles the request
 * that useToolAssignment().requestAssignment opened: Download confirms,
 * Cancel, Escape and a click outside cancel.
 */

const tools = useToolAssignment();
const { bodyText, labelText } = storeToRefs(tools);

function onOpenChange(open: boolean): void {
  if (!open) tools.cancelRequest();
}
</script>

<template>
  <v-dialog :model-value="tools.dialogOpen" max-width="400" @update:model-value="onOpenChange">
    <v-card>
      <form @submit.prevent="tools.confirmRequest()">
        <v-card-title>Choose the tools for the 3MF</v-card-title>
        <v-card-text>
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
              autofocus
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
          <p class="text-caption text-medium-emphasis mb-0">
            These are the Orca Slicer filament slots the base and the raised label text print with.
          </p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="tools.cancelRequest()">Cancel</v-btn>
          <v-btn
            type="submit"
            color="primary"
            variant="flat"
            :disabled="tools.assignment === null"
          >
            Download
          </v-btn>
        </v-card-actions>
      </form>
    </v-card>
  </v-dialog>
</template>
