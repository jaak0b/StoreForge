<script setup lang="ts">
/**
 * The one delete-drawer confirm dialog, shared by the drawer detail view and
 * the queue's group header rows so the wording and warnings stay identical.
 * States how many still-queued plate rows the delete also removes and, when
 * any plate has already printed, that the printed record is lost.
 */

defineProps<{
  modelValue: boolean;
  queuedCount: number;
  doneCount: number;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void;
  (event: 'confirm'): void;
}>();
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="440"
    @update:model-value="(value: boolean) => emit('update:modelValue', value)"
  >
    <v-card>
      <v-card-title>Delete this drawer?</v-card-title>
      <v-card-text>
        <p class="mb-2">
          Deleting the drawer also removes its {{ queuedCount }}
          {{ queuedCount === 1 ? 'queued plate row' : 'queued plate rows' }} from
          the queue. Plates already on a build plate are left alone.
        </p>
        <p v-if="doneCount > 0" class="mb-0">
          The record of the {{ doneCount }}
          {{ doneCount === 1 ? 'plate' : 'plates' }} already printed for this
          drawer is lost.
        </p>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="error" variant="flat" @click="emit('confirm')">Delete</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
