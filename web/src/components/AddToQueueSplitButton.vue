<script setup lang="ts">
import type { ProductDownload } from '../binDownloads';
import { useToolAssignment } from '../stores/toolAssignment';
import ToolAssignmentFields from './ToolAssignmentFields.vue';

/**
 * The split add button of the add/edit tabs: the primary button queues (or
 * saves the edit) exactly as the plain button did, and a joined dropdown
 * opens the secondary actions (queue onto the newest build plate, or download
 * the design directly as STL or 3MF, with the shared base and label tool
 * fields beside the 3MF entry). In edit mode the dropdown is hidden:
 * the secondary actions only apply to a new design. The component is
 * presentation only; the owning tab performs every action.
 */

withDefaults(
  defineProps<{
    /** Whether the tab is editing an existing queue entry. */
    editing: boolean;
    /** Disables the primary button and the dropdown alike. */
    disabled?: boolean;
    /** Button size, matching whatever the tab's plain button used. */
    size?: string;
  }>(),
  { disabled: false, size: 'large' },
);

const emit = defineEmits<{
  add: [];
  addToPlate: [];
  download: [request: ProductDownload];
}>();

const tools = useToolAssignment();

function download3mf(): void {
  const assignment = tools.assignment;
  // The entry is disabled while a tool field is invalid, so this is a
  // defensive stop, not a reachable path.
  if (assignment === null) return;
  emit('download', { format: '3mf', tools: assignment });
}
</script>

<template>
  <div class="d-flex split-root">
    <v-btn
      color="primary"
      variant="flat"
      :size="size"
      class="flex-grow-1"
      :class="{ 'split-main': !editing }"
      :disabled="disabled"
      @click="emit('add')"
    >
      {{ editing ? 'Save changes' : 'Add to queue' }}
    </v-btn>
    <v-btn
      v-if="!editing"
      color="primary"
      variant="flat"
      :size="size"
      class="split-arrow"
      :disabled="disabled"
      aria-label="More ways to use this design"
    >
      <v-icon icon="mdi-chevron-down" />
      <v-menu activator="parent">
        <v-list density="compact">
          <v-list-item title="Add to newest build plate" @click="emit('addToPlate')" />
          <v-list-item title="Download STL" @click="emit('download', { format: 'stl' })" />
          <v-list-item
            title="Download 3MF"
            :disabled="tools.assignment === null"
            @click="download3mf"
          />
          <ToolAssignmentFields />
        </v-list>
      </v-menu>
    </v-btn>
  </div>
</template>

<style scoped>
.split-main {
  /* !important: the host tab's rounded-lg utility class sets all corners with
     !important, and the shared edge must stay square. */
  border-top-right-radius: 0 !important;
  border-bottom-right-radius: 0 !important;
}
.split-arrow {
  border-top-left-radius: 0 !important;
  border-bottom-left-radius: 0 !important;
  border-left: 1px solid rgba(255, 255, 255, 0.2);
  min-width: 44px;
  padding: 0;
  margin-left: 0;
}
.split-root {
  gap: 0;
}
</style>
