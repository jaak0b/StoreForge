<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MeshData } from '../engine/gridfinity/types';

const props = defineProps<{ mesh: MeshData | null; label?: MeshData | null }>();

const container = ref<HTMLDivElement | null>(null);

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let binMesh: THREE.Mesh | null = null;
let labelMesh: THREE.Mesh | null = null;
let resizeObserver: ResizeObserver | null = null;
let animationHandle = 0;

// CSG output is welded: every face is planar and every shared edge is a
// genuinely hard edge, so averaged vertex normals smear across them. Flat
// shading uses the face normal instead.
const material = new THREE.MeshStandardMaterial({
  color: 0xa8a8a8,
  metalness: 0.05,
  roughness: 0.65,
  flatShading: true,
});

// A light near-neutral so the raised label face reads clearly against the
// darker grey body, standing in for the second filament.
const labelMaterial = new THREE.MeshStandardMaterial({
  color: 0xe0dcd5,
  metalness: 0.05,
  roughness: 0.55,
  flatShading: true,
});

function buildMesh(mesh: MeshData, meshMaterial: THREE.Material): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeVertexNormals();
  // Model space is Z-up millimetres; three.js scenes are Y-up.
  const built = new THREE.Mesh(geometry, meshMaterial);
  built.rotation.x = -Math.PI / 2;
  return built;
}

function updateMesh(mesh: MeshData | null, label: MeshData | null): void {
  if (!scene) return;
  if (binMesh) {
    scene.remove(binMesh);
    binMesh.geometry.dispose();
    binMesh = null;
  }
  if (labelMesh) {
    scene.remove(labelMesh);
    labelMesh.geometry.dispose();
    labelMesh = null;
  }
  if (!mesh) return;
  binMesh = buildMesh(mesh, material);
  scene.add(binMesh);
  if (label) {
    labelMesh = buildMesh(label, labelMaterial);
    scene.add(labelMesh);
  }
}

function resize(): void {
  if (!renderer || !camera || !container.value) return;
  const { clientWidth, clientHeight } = container.value;
  if (clientWidth === 0 || clientHeight === 0) return;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
}

onMounted(() => {
  const el = container.value;
  if (!el) return;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  el.appendChild(renderer.domElement);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x121212);

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  camera.position.set(90, 80, 110);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 15, 0);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4a4a, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(80, 120, 60);
  scene.add(key);

  const grid = new THREE.GridHelper(420, 42, 0x3a3a3a, 0x242424);
  scene.add(grid);

  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(el);
  resize();
  updateMesh(props.mesh, props.label ?? null);

  const animate = () => {
    animationHandle = requestAnimationFrame(animate);
    controls?.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
  };
  animate();
});

watch(
  () => [props.mesh, props.label ?? null] as const,
  ([mesh, label]) => updateMesh(mesh, label),
);

onBeforeUnmount(() => {
  cancelAnimationFrame(animationHandle);
  resizeObserver?.disconnect();
  controls?.dispose();
  binMesh?.geometry.dispose();
  labelMesh?.geometry.dispose();
  material.dispose();
  labelMaterial.dispose();
  renderer?.dispose();
});
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
