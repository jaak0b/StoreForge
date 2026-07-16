<script setup lang="ts">
/**
 * Compact integer input with explicit minus/plus buttons, used for the
 * per-row plate amount and the batch confirm amount. Native spinners are
 * hidden globally, so stepping happens through these buttons (or the
 * arrow keys while the input is focused).
 */

const props = withDefaults(defineProps<{ min?: number; max?: number }>(), {
  min: 1,
  max: undefined,
});

const model = defineModel<number>({ required: true });

function clamp(value: number): number {
  if (!Number.isFinite(value)) return props.min;
  let n = Math.floor(value);
  if (n < props.min) n = props.min;
  if (props.max !== undefined && n > props.max) n = props.max;
  return n;
}

function step(delta: number): void {
  model.value = clamp(model.value + delta);
}

function onInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.value === '') return; // wait for a digit; blur re-syncs the display
  const clamped = clamp(Number(input.value));
  model.value = clamped;
  // If clamping rejected the typed value, the model may not change and Vue
  // will not re-render, so sync the display directly.
  if (input.value !== String(clamped)) input.value = String(clamped);
}

function onBlur(event: Event): void {
  (event.target as HTMLInputElement).value = String(model.value);
}
</script>

<template>
  <div class="count-stepper d-flex align-center">
    <v-btn
      icon
      size="x-small"
      variant="text"
      :disabled="model <= props.min"
      aria-label="Decrease"
      @click="step(-1)"
    >
      <v-icon icon="mdi-minus" size="14" />
    </v-btn>
    <input
      class="count-input"
      type="number"
      :value="model"
      :min="props.min"
      :max="props.max"
      @input="onInput"
      @blur="onBlur"
      @keydown.up.prevent="step(1)"
      @keydown.down.prevent="step(-1)"
    />
    <v-btn
      icon
      size="x-small"
      variant="text"
      :disabled="props.max !== undefined && model >= props.max"
      aria-label="Increase"
      @click="step(1)"
    >
      <v-icon icon="mdi-plus" size="14" />
    </v-btn>
  </div>
</template>

<style scoped>
.count-stepper {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.16);
  border-radius: 8px;
  background: rgb(var(--v-theme-surface));
}

.count-stepper:focus-within {
  border-color: rgb(var(--v-theme-primary));
}

.count-input {
  width: 36px;
  text-align: center;
  background: transparent;
  border: none;
  outline: none;
  color: rgb(var(--v-theme-on-surface));
  font-family: monospace;
  font-size: 13px;
  padding: 4px 0;
}
</style>
