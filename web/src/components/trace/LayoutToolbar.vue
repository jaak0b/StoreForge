<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { CLEARANCE_CHOICES, useToolTrace } from '../../stores/toolTrace';

/**
 * The toolbar strip docked at the top of the layout canvas. Its left half
 * carries the selection controls and renders only while a tool is selected;
 * its right half carries the global actions (trace another tool, add a basic
 * shape, the 3D toggle and the drawer toggle), so the two can never overlap.
 * On narrow widths (a container query on the bar itself) the bar drops the
 * tool name and the clearance and depth value fields; those stay reachable
 * in the drawer's Trace tab, bound to the same store state. All mutations go
 * through the toolTrace store's layout-model wrappers.
 */

const props = defineProps<{
  /** True when a tool can be re-traced (embedding ready or photo stored). */
  retraceAvailable: boolean;
}>();

const show3d = defineModel<boolean>('show3d', { required: true });
const drawerOpen = defineModel<boolean>('drawerOpen', { required: true });

const emit = defineEmits<{
  /** Asks the workspace to re-trace the tool from its stored clicks. */
  retrace: [toolId: string];
  /** Asks the workspace to switch to Trace mode for another tool. */
  traceAnother: [];
  /** Opens the basic-shape dialog. */
  addShape: [];
}>();

const trace = useToolTrace();
const { selectedToolId, fingerHoleMode } = storeToRefs(trace);

const tool = computed(() =>
  selectedToolId.value !== null
    ? trace.tools.find((t) => t.id === selectedToolId.value) ?? null
    : null,
);

const placement = computed(() =>
  selectedToolId.value !== null
    ? trace.placementOf(selectedToolId.value) ?? null
    : null,
);

function nudgeRotation(deltaDeg: number): void {
  if (tool.value === null) return;
  trace.setToolTransform(tool.value.id, {
    rotationDeg: tool.value.rotationDeg + deltaDeg,
  });
}

function toggleMirror(): void {
  if (tool.value === null) return;
  trace.setToolTransform(tool.value.id, { mirrored: !tool.value.mirrored });
}

function setClearance(value: unknown): void {
  if (tool.value === null) return;
  trace.setToolTransform(tool.value.id, { offsetMm: Number(value) });
}

function setDepth(value: unknown): void {
  if (tool.value === null) return;
  const depth = Number(value);
  if (!Number.isFinite(depth) || depth <= 0) return;
  trace.setPocketDepth(tool.value.id, depth);
}

function removeTool(): void {
  if (tool.value === null) return;
  trace.removeTool(tool.value.id);
}
</script>

<template>
  <div class="toolbar-host">
    <div class="layout-toolbar">
      <div v-if="tool !== null && placement !== null" class="selection-half">
        <span class="tool-name text-body-2 text-truncate">{{ tool.name }}</span>
        <v-btn icon size="small" variant="text" @click="nudgeRotation(-15)">
          <v-icon icon="mdi-rotate-left" size="20" />
          <v-tooltip activator="parent" location="bottom">Rotate 15 degrees counterclockwise</v-tooltip>
        </v-btn>
        <v-btn icon size="small" variant="text" @click="nudgeRotation(15)">
          <v-icon icon="mdi-rotate-right" size="20" />
          <v-tooltip activator="parent" location="bottom">Rotate 15 degrees clockwise</v-tooltip>
        </v-btn>
        <v-btn
          icon
          size="small"
          :variant="tool.mirrored ? 'tonal' : 'text'"
          :color="tool.mirrored ? 'primary' : undefined"
          @click="toggleMirror"
        >
          <v-icon icon="mdi-flip-horizontal" size="20" />
          <v-tooltip activator="parent" location="bottom">Mirror the tool</v-tooltip>
        </v-btn>
        <v-select
          :model-value="tool.offsetMm"
          :items="CLEARANCE_CHOICES"
          density="compact"
          hide-details
          variant="plain"
          class="toolbar-field clearance-field value-field"
          @update:model-value="setClearance"
        >
          <template #prepend-inner>
            <span class="field-tag">Clearance</span>
          </template>
          <template #selection="{ item }">
            <span class="field-value">{{ item.value }} mm</span>
          </template>
        </v-select>
        <v-text-field
          :model-value="placement.pocketDepthMm"
          type="number"
          min="1"
          step="1"
          density="compact"
          hide-details
          variant="plain"
          class="toolbar-field depth-field value-field"
          @update:model-value="setDepth"
        >
          <template #prepend-inner>
            <span class="field-tag">Depth mm</span>
          </template>
        </v-text-field>
        <v-btn
          icon
          size="small"
          :variant="fingerHoleMode ? 'tonal' : 'text'"
          :color="fingerHoleMode ? 'primary' : undefined"
          @click="fingerHoleMode = !fingerHoleMode"
        >
          <v-icon icon="mdi-circle-outline" size="20" />
          <v-tooltip activator="parent" location="bottom">
            {{
              fingerHoleMode
                ? 'Finger-hole mode is on: press on a tool to place a hole, drag to stretch it into a slot.'
                : 'Add a finger hole'
            }}
          </v-tooltip>
        </v-btn>
        <v-menu>
          <template #activator="{ props: menuProps }">
            <v-btn icon size="small" variant="text" v-bind="menuProps">
              <v-icon icon="mdi-dots-vertical" size="20" />
            </v-btn>
          </template>
          <v-list density="compact">
            <v-list-item
              prepend-icon="mdi-content-copy"
              title="Duplicate"
              @click="trace.duplicateTool(tool.id)"
            />
            <v-list-item
              v-if="tool.clicks.length > 0"
              prepend-icon="mdi-magic-staff"
              title="Re-trace"
              :disabled="!props.retraceAvailable"
              @click="emit('retrace', tool.id)"
            />
            <v-list-item
              prepend-icon="mdi-delete-outline"
              title="Delete"
              base-color="error"
              @click="removeTool"
            />
          </v-list>
        </v-menu>
      </div>
      <div class="flex-spacer" />
      <div class="cluster-half">
        <v-btn icon size="small" variant="tonal" :disabled="!props.retraceAvailable" @click="emit('traceAnother')">
          <v-icon icon="mdi-plus" size="20" />
          <v-tooltip activator="parent" location="bottom">Trace another tool</v-tooltip>
        </v-btn>
        <v-btn icon size="small" variant="tonal" @click="emit('addShape')">
          <v-icon icon="mdi-shape-outline" size="20" />
          <v-tooltip activator="parent" location="bottom">Add a basic shape</v-tooltip>
        </v-btn>
        <v-btn
          icon
          size="small"
          :variant="show3d ? 'flat' : 'tonal'"
          :color="show3d ? 'primary' : undefined"
          @click="show3d = !show3d"
        >
          <v-icon icon="mdi-video-3d" size="20" />
          <v-tooltip activator="parent" location="bottom">
            {{ show3d ? 'Back to the 2D layout' : 'Show the 3D preview' }}
          </v-tooltip>
        </v-btn>
        <v-btn
          icon
          size="small"
          :variant="drawerOpen ? 'flat' : 'tonal'"
          :color="drawerOpen ? 'primary' : undefined"
          @click="drawerOpen = !drawerOpen"
        >
          <v-icon icon="mdi-pencil" size="20" />
          <v-tooltip activator="parent" location="bottom">
            {{ drawerOpen ? 'Close the editing drawer' : 'Open the editing drawer' }}
          </v-tooltip>
        </v-btn>
      </div>
    </div>
  </div>
</template>

<style scoped>
.toolbar-host {
  container-type: inline-size;
}

.layout-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px 8px;
  padding: 4px 8px;
  margin-bottom: 8px;
  border-radius: 8px;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgba(var(--v-theme-on-surface), 0.16);
}

.selection-half {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  min-width: 0;
}

.flex-spacer {
  flex: 1 1 auto;
}

.cluster-half {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.tool-name {
  max-width: 160px;
  margin-right: 4px;
}

.toolbar-field {
  flex: 0 0 auto;
}

.toolbar-field :deep(.v-field__input) {
  padding-top: 4px;
  padding-bottom: 4px;
  min-height: 32px;
  font-size: 0.8125rem;
}

.clearance-field {
  width: 128px;
}

.depth-field {
  width: 110px;
}

.field-tag {
  font-size: 0.625rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgba(var(--v-theme-on-surface), 0.6);
  margin-right: 4px;
  align-self: center;
}

.field-value {
  white-space: nowrap;
}

/* Narrow bar: icons only; the value fields live in the drawer's Trace tab. */
@container (max-width: 600px) {
  .tool-name,
  .value-field {
    display: none;
  }
}
</style>
