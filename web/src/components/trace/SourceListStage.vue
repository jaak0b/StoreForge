<script setup lang="ts">
import type { TracedTool, TraceSession } from '../../engine/trace/types';

/**
 * The Sources stage of the Tool trace tab: one card per photographed sheet
 * and per sketched tool, plus the two actions that add a new source. With no
 * sources yet, only the two large actions show, so the common single-sheet
 * or single-sketch flow stays as short as the old two-button screen.
 */

const props = defineProps<{
  sessions: TraceSession[];
  sketchTools: TracedTool[];
  busy: boolean;
}>();

const emit = defineEmits<{
  openSheet: [sessionId: string];
  openSketch: [toolId: string];
  addPhoto: [];
  drawShape: [];
}>();
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <div v-if="props.sessions.length > 0 || props.sketchTools.length > 0" class="source-grid">
      <v-card
        v-for="(session, index) in props.sessions"
        :key="session.id"
        :disabled="props.busy"
        variant="outlined"
        class="source-card"
        @click="emit('openSheet', session.id)"
      >
        <v-card-item>
          <v-card-title class="text-body-1">Photo sheet {{ index + 1 }}</v-card-title>
          <v-card-subtitle>
            {{ session.paper.kind === 'a4' ? 'A4 sheet' : 'Letter sheet' }}. Open to trace
            more tools or re-trace existing ones.
          </v-card-subtitle>
        </v-card-item>
      </v-card>
      <v-card
        v-for="tool in props.sketchTools"
        :key="tool.id"
        :disabled="props.busy"
        variant="outlined"
        class="source-card"
        @click="emit('openSketch', tool.id)"
      >
        <v-card-item>
          <v-card-title class="text-body-1">{{ tool.name }}</v-card-title>
          <v-card-subtitle>Sketched shape. Open to edit the sketch.</v-card-subtitle>
        </v-card-item>
      </v-card>
    </div>
    <div class="d-flex flex-wrap ga-3">
      <v-btn
        :disabled="props.busy"
        size="large"
        prepend-icon="mdi-camera-plus"
        @click="emit('addPhoto')"
      >
        Add a photo sheet
      </v-btn>
      <v-btn
        :disabled="props.busy"
        size="large"
        prepend-icon="mdi-draw"
        @click="emit('drawShape')"
      >
        Draw a shape
      </v-btn>
    </div>
  </div>
</template>

<style scoped>
.source-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.source-card {
  cursor: pointer;
}
@media (max-width: 599px) {
  /* Source cards stack full width in one column on phones (375 px). */
  .source-grid {
    grid-template-columns: 1fr;
  }
}
</style>
