<script setup lang="ts">
/**
 * The app's one confirm dialog shell: a title, a message body (slot or plain
 * text), and Cancel/confirm actions. DeleteDrawerDialog wraps this with its
 * drawer-specific wording; any other destructive confirmation (source
 * deletion in the Tool trace tab, "start over") uses it directly instead of
 * growing its own dialog markup.
 */

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    message?: string;
    confirmLabel?: string;
    confirmColor?: string;
  }>(),
  {
    message: undefined,
    confirmLabel: 'Delete',
    confirmColor: 'error',
  },
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void;
  (event: 'confirm'): void;
}>();

void props;
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="440"
    @update:model-value="(value: boolean) => emit('update:modelValue', value)"
  >
    <v-card>
      <v-card-title>{{ title }}</v-card-title>
      <v-card-text>
        <slot>
          <p class="mb-0">{{ message }}</p>
        </slot>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn :color="confirmColor" variant="flat" @click="emit('confirm')">
          {{ confirmLabel }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
