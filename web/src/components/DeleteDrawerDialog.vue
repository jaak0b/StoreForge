<script setup lang="ts">
import { computed } from 'vue';
import ConfirmDialog from './ConfirmDialog.vue';

/**
 * The delete-drawer confirm dialog, shared by the drawer detail view and the
 * queue's group header rows so the wording and warnings stay identical. Wraps
 * the app's generic ConfirmDialog shell with drawer-specific wording. States
 * how many still-queued baseplates and connection clips the delete also
 * removes and, when any plate has already printed, that the printed record
 * is lost.
 */

const props = defineProps<{
  modelValue: boolean;
  queuedCount: number;
  queuedClipCount: number;
  doneCount: number;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void;
  (event: 'confirm'): void;
}>();

/**
 * Names what the delete removes from the queue, naming only the kinds with a
 * non-zero count. Empty when nothing linked is still queued.
 */
const removalPhrase = computed(() => {
  const parts: string[] = [];
  if (props.queuedCount > 0) {
    parts.push(
      `${props.queuedCount} queued ${props.queuedCount === 1 ? 'baseplate' : 'baseplates'}`,
    );
  }
  if (props.queuedClipCount > 0) {
    parts.push(
      `${props.queuedClipCount} connection ${props.queuedClipCount === 1 ? 'clip' : 'clips'}`,
    );
  }
  return parts.join(' and ');
});
</script>

<template>
  <ConfirmDialog
    :model-value="modelValue"
    title="Delete this drawer?"
    confirm-label="Delete"
    @update:model-value="(value: boolean) => emit('update:modelValue', value)"
    @confirm="emit('confirm')"
  >
    <p class="mb-2">
      <template v-if="removalPhrase !== ''">
        Deleting the drawer also removes its {{ removalPhrase }} from the
        queue.
      </template>
      Plates already on a build plate are left alone.
    </p>
    <p v-if="doneCount > 0" class="mb-0">
      The record of the {{ doneCount }}
      {{ doneCount === 1 ? 'plate' : 'plates' }} already printed for this
      drawer is lost.
    </p>
  </ConfirmDialog>
</template>
