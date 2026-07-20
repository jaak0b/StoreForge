<script setup lang="ts">
import { ref, watch } from 'vue';
import * as THREE from 'three';
import type { MeshData } from '../engine/gridfinity/types';
import {
  buildMeshObject,
  createBodyMaterial,
  createLabelMaterial,
  useThreeScene,
} from '../composables/useThreeScene';

const props = defineProps<{ mesh: MeshData | null; label?: MeshData | null }>();

const material = createBodyMaterial();
const labelMaterial = createLabelMaterial();

let binMesh: THREE.Mesh | null = null;
let labelMesh: THREE.Mesh | null = null;

const container = ref<HTMLDivElement | null>(null);

const { context } = useThreeScene(container, {
  onReady: () => updateMesh(props.mesh, props.label ?? null),
  onTeardown: () => {
    binMesh?.geometry.dispose();
    labelMesh?.geometry.dispose();
    material.dispose();
    labelMaterial.dispose();
  },
});

function updateMesh(mesh: MeshData | null, label: MeshData | null): void {
  const ctx = context.value;
  if (!ctx) return;
  if (binMesh) {
    ctx.modelRoot.remove(binMesh);
    binMesh.geometry.dispose();
    binMesh = null;
  }
  if (labelMesh) {
    ctx.modelRoot.remove(labelMesh);
    labelMesh.geometry.dispose();
    labelMesh = null;
  }
  if (!mesh) return;
  binMesh = buildMeshObject(mesh, material);
  ctx.modelRoot.add(binMesh);
  if (label) {
    labelMesh = buildMeshObject(label, labelMaterial);
    ctx.modelRoot.add(labelMesh);
  }
}

watch(
  () => [props.mesh, props.label ?? null] as const,
  ([mesh, label]) => updateMesh(mesh, label),
);
</script>

<template>
  <div ref="container" class="viewport" />
</template>

<style scoped>
.viewport {
  width: 100%;
  height: 100%;
  min-height: 420px;
}
</style>
