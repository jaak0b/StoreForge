<script setup lang="ts">
import { ref, watch } from 'vue';
import type { MeshData } from '../engine/gridfinity/types';
import { useThreeScene } from '../composables/useThreeScene';
import { useBinMesh } from '../composables/useBinMesh';

const props = defineProps<{ mesh: MeshData | null; label?: MeshData | null }>();

const binMesh = useBinMesh();

const container = ref<HTMLDivElement | null>(null);

const { context } = useThreeScene(container, {
  onReady: (ctx) => binMesh.sync(ctx, props.mesh, props.label ?? null),
  onTeardown: (ctx) => binMesh.dispose(ctx),
});

watch(
  () => [props.mesh, props.label ?? null] as const,
  ([mesh, label]) => {
    const ctx = context.value;
    if (ctx) binMesh.sync(ctx, mesh, label);
  },
);
</script>

<template>
  <div ref="container" class="viewport" />
</template>

<style scoped>
.viewport {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 420px;
}
</style>
