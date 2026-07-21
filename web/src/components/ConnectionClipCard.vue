<script setup lang="ts">
import { CLIP_TOLERANCE_MAX, CLIP_TOLERANCE_MIN } from '../engine/baseplate/constants';

/**
 * The Connection clips control, shared by the single-plate Baseplate tab and the
 * fill-a-drawer panel so the tolerance slider and its wording live in one place.
 * The single-plate host passes a quantity model and a submit label to show the
 * quantity field and the Add/Save button (and a Cancel when editing an existing
 * clip row); the fill-a-drawer host passes the auto clip count to show instead,
 * since the drawer queues its clips itself. The host owns the tolerance value
 * (clamping and quantizing it on submit) and every action; this component is
 * only the markup.
 */

const toleranceMm = defineModel<number>('toleranceMm', { required: true });
const quantity = defineModel<number>('quantity');

defineProps<{
  /** The auto-computed clip count to show as a readout, or null to hide it (single-plate mode). */
  count?: number | null;
  /** Label for the submit button, or null to hide it (fill mode). */
  submitLabel?: string | null;
  /** Whether to show the quantity field (single-plate mode). */
  showQuantity?: boolean;
  /** Whether to show the Cancel edit button (single-plate edit mode). */
  showCancel?: boolean;
  /** The host's error to show under the controls, or null for none. */
  error?: string | null;
}>();

const emit = defineEmits<{ submit: []; cancel: [] }>();
</script>

<template>
  <v-card variant="tonal" density="compact">
    <v-card-item>
      <v-card-title>Connection clips</v-card-title>
    </v-card-item>
    <v-card-text>
      <dl v-if="count != null" class="clip-readout mb-1">
        <div>
          <dt>Clips</dt>
          <dd>{{ count }}</dd>
        </div>
      </dl>
      <v-slider
        v-model="toleranceMm"
        :min="CLIP_TOLERANCE_MIN"
        :max="CLIP_TOLERANCE_MAX"
        step="0.05"
        label="Clip tolerance (mm)"
        hint="Raise it when the clip prints too tight to push into the joint."
        persistent-hint
      >
        <template #append>
          <v-text-field
            v-model.number="toleranceMm"
            type="number"
            :min="CLIP_TOLERANCE_MIN"
            :max="CLIP_TOLERANCE_MAX"
            step="0.05"
            density="compact"
            hide-details
            style="width: 90px"
          />
        </template>
      </v-slider>
      <div v-if="showQuantity || submitLabel" class="d-flex align-center ga-2 mt-4">
        <v-text-field
          v-if="showQuantity"
          v-model.number="quantity"
          type="number"
          min="1"
          step="1"
          label="Quantity"
          density="comfortable"
          hide-details
          style="max-width: 140px"
        />
        <v-btn v-if="submitLabel" variant="outlined" @click="emit('submit')">
          {{ submitLabel }}
        </v-btn>
        <v-btn v-if="showCancel" variant="outlined" @click="emit('cancel')">
          Cancel edit
        </v-btn>
      </div>
      <v-alert v-if="error" type="error" class="mt-4" density="compact">
        {{ error }}
      </v-alert>
    </v-card-text>
  </v-card>
</template>

<style scoped>
/* The clip count readout: a labeled row, value in a monospace column. */
.clip-readout {
  margin: 0;
  max-width: 220px;
}
.clip-readout > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.clip-readout dt {
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  font-size: 0.8125rem;
}
.clip-readout dd {
  margin: 0;
  font-family: monospace;
  font-size: 0.8125rem;
}
</style>
