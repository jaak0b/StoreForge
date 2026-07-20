<script setup lang="ts">
import { ref } from 'vue';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { MeshData, PartMeshes } from '../../engine/gridfinity/types';
import type { MeshBounds } from '../../engine/cutout/cutoutMesh';
import type { ModelPlacement } from '../../engine/cutout/cutoutBin';
import { ERROR, INFO, PRIMARY } from '../../themeColors';
import type { CutoutGhost, CutoutGhostMoved } from './cutoutGhost';
import {
  buildMeshObject,
  createBodyMaterial,
  createLabelMaterial,
  useThreeScene,
  type ThreeSceneContext,
} from '../../composables/useThreeScene';

/**
 * The cutout bin editor's viewport: the carved bin, the placed models drawn as
 * translucent ghosts, and the gizmo that moves and turns the selected one.
 *
 * Two tiers of preview meet here. The carved bin is geometry the worker
 * produced and this component only draws. The ghosts are the imported
 * triangles drawn directly and transformed on the main thread, so a drag runs
 * at frame rate with no CSG at all; the real carve is what the parent starts
 * once the drag ends.
 */

const props = defineProps<{
  /** The carved bin, or null while no carve has landed yet. */
  meshes: PartMeshes | null;
  /** The placed models, in list order. */
  ghosts: CutoutGhost[];
  /** Which model the gizmo is attached to, or null for no selection. */
  selectedModelId: string | null;
  /**
   * Ids of the models the last carve warned about. These are painted red,
   * whether or not they are also the selected model.
   */
  warnedModelIds: readonly string[];
}>();

const emit = defineEmits<{
  /** A ghost was clicked, or empty space was clicked to clear the selection. */
  'update:selectedModelId': [id: string | null];
  /** The selected model moved. Fires continuously through a drag, and carves nothing. */
  placementChange: [moved: CutoutGhostMoved];
  /** The drag ended. This is the event a fresh carve should start from. */
  placementCommit: [moved: CutoutGhostMoved];
  /**
   * A ghost's exact bounds were recomputed, because it was drawn for the first
   * time or its placement changed from outside a drag. Only this component
   * holds the transformed triangles, so it is the only place these bounds can
   * be measured without keeping a second copy of every model.
   *
   * The tab needs them for the model readout's footprint and resting height
   * rows, and for sizing the bin around the models where they stand.
   */
  boundsChange: [moved: CutoutGhostMoved];
}>();

/**
 * Size of the rotate gizmo relative to the translate gizmo, which stays at the
 * default 1.
 *
 * Derived from the handle geometry rather than judged by eye: the translate
 * arrow cones sit at 0.5 on each axis and the rotation arcs are a torus of
 * radius 0.5, so at equal sizes the arcs pass exactly through the arrow tips
 * and neither is reliably grabbable. At 1.6 the arcs sit at 0.8 with a clear
 * band between them and the arrow tips, and the outer free-rotation ring lands
 * at 1.2.
 */
const ROTATE_GIZMO_SIZE = 1.6;

/**
 * How far the pointer may travel between press and release and still count as
 * a click rather than an orbit, in pixels. Small enough that a deliberate
 * camera drag never selects a model, loose enough that the hand tremor in a
 * click on a trackpad still does.
 */
const CLICK_TOLERANCE_PX = 4;

/**
 * What a ghost's colour says about it. Exactly three states, in the order they
 * take precedence.
 *
 * A warning outranks the selection deliberately. The selected model already
 * carries the gizmo, so which one is selected is unmistakable without any
 * colour at all, whereas a warning is the thing the user can miss. Painting the
 * selected model blue over a warning would hide the warning on the one model he
 * is actually working on.
 */
type GhostTone = 'warned' | 'selected' | 'plain';

/** A drawn ghost, the geometry it was built from, its bounds and its colour. */
interface GhostEntry {
  mesh: THREE.Mesh;
  source: MeshData;
  bounds: MeshBounds;
  /**
   * The tone its current material was chosen for, or null before it has been
   * painted once. Recorded rather than inferred, so the paint pass can tell a
   * ghost that is already the right colour from one that is stale, and no
   * selection or warning change can leave a ghost showing an old material.
   */
  painted: GhostTone | null;
}

const bodyMaterial = createBodyMaterial();
const labelMaterial = createLabelMaterial();

/**
 * The three ghost materials, one per tone, taking their colours from the
 * theme's own accents: the amber the app accents everything with, the info blue
 * and the error red.
 *
 * Ghosts are drawn translucent so a model sunk into the bin still reads, and
 * with depth writing off so two overlapping ghosts do not punch holes in each
 * other. Depth testing stays on: a model hidden behind a bin wall is genuinely
 * not clickable in the viewport, which is why the model list is the selection
 * path that always works.
 */
function createGhostMaterial(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    metalness: 0.05,
    roughness: 0.5,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
}

/**
 * Keyed by the tone rather than switched on it. A record over the union is
 * total by construction: a tone added later is a compile error here, at the
 * definition, rather than a case that falls through at run time.
 */
const ghostMaterials: Record<GhostTone, THREE.MeshStandardMaterial> = {
  plain: createGhostMaterial(PRIMARY),
  selected: createGhostMaterial(INFO),
  warned: createGhostMaterial(ERROR),
};

let binMesh: THREE.Mesh | null = null;
let binLabelMesh: THREE.Mesh | null = null;
let drawnMeshes: PartMeshes | null = null;

const ghostEntries = new Map<string, GhostEntry>();

let translateControls: TransformControls | null = null;
let rotateControls: TransformControls | null = null;
let attachedId: string | null = null;
let draggingId: string | null = null;

let pointerDownX = 0;
let pointerDownY = 0;
let pointerDownButton = -1;

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const scratchVertex = new THREE.Vector3();

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function applyPlacement(mesh: THREE.Mesh, placement: ModelPlacement): void {
  mesh.position.set(placement.xMm, placement.yMm, placement.zMm);
  mesh.rotation.set(
    degToRad(placement.rotXDeg),
    degToRad(placement.rotYDeg),
    degToRad(placement.rotZDeg),
  );
}

function placementOf(mesh: THREE.Mesh): ModelPlacement {
  return {
    xMm: mesh.position.x,
    yMm: mesh.position.y,
    zMm: mesh.position.z,
    rotXDeg: radToDeg(mesh.rotation.x),
    rotYDeg: radToDeg(mesh.rotation.y),
    rotZDeg: radToDeg(mesh.rotation.z),
  };
}

function samePlacement(a: ModelPlacement, b: ModelPlacement): boolean {
  return (
    a.xMm === b.xMm &&
    a.yMm === b.yMm &&
    a.zMm === b.zMm &&
    a.rotXDeg === b.rotXDeg &&
    a.rotYDeg === b.rotYDeg &&
    a.rotZDeg === b.rotZDeg
  );
}

/**
 * Exact bounds of a placed ghost in bin-local millimetres, walking the
 * transformed vertices rather than transforming a bounding box. Transforming
 * the eight corners of the untransformed box is cheaper but overestimates every
 * shape that is not itself a box, so the footprint the readout shows would be
 * wrong and the bin the fit button sizes would come out larger than the models
 * need.
 */
function ghostBounds(mesh: THREE.Mesh): MeshBounds {
  const position = mesh.geometry.getAttribute('position');
  mesh.updateMatrix();
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < position.count; i += 1) {
    scratchVertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrix);
    if (scratchVertex.x < minX) minX = scratchVertex.x;
    if (scratchVertex.y < minY) minY = scratchVertex.y;
    if (scratchVertex.z < minZ) minZ = scratchVertex.z;
    if (scratchVertex.x > maxX) maxX = scratchVertex.x;
    if (scratchVertex.y > maxY) maxY = scratchVertex.y;
    if (scratchVertex.z > maxZ) maxZ = scratchVertex.z;
  }
  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    sizeX: maxX - minX,
    sizeY: maxY - minY,
    sizeZ: maxZ - minZ,
  };
}

/** What a ghost's colour should say right now, warning ahead of selection. */
function toneOf(id: string): GhostTone {
  if (props.warnedModelIds.includes(id)) return 'warned';
  if (id === props.selectedModelId) return 'selected';
  return 'plain';
}

/**
 * Give every drawn ghost the material its current tone calls for.
 *
 * Runs over the whole map on every frame rather than at the point something
 * changes, and that is the point: the tone is a pure function of the props, so
 * a ghost cannot be left holding a material chosen for a state that has since
 * passed. Selecting a second model repaints the one that lost the selection as
 * well as the one that gained it, whichever way the selection was changed, and
 * clearing the selection returns its ghost to the plain colour. The recorded
 * tone keeps the pass down to a comparison per ghost when nothing changed.
 */
function paintGhosts(): void {
  for (const [id, entry] of ghostEntries) {
    const tone = toneOf(id);
    if (tone === entry.painted) continue;
    entry.painted = tone;
    entry.mesh.material = ghostMaterials[tone];
  }
}

/** Recompute a ghost's bounds after it moved. */
function refreshBounds(entry: GhostEntry): void {
  entry.bounds = ghostBounds(entry.mesh);
}

function disposeGhost(ctx: ThreeSceneContext, entry: GhostEntry): void {
  ctx.modelRoot.remove(entry.mesh);
  entry.mesh.geometry.dispose();
}

function syncBin(ctx: ThreeSceneContext): void {
  if (props.meshes === drawnMeshes) return;
  drawnMeshes = props.meshes;
  if (binMesh) {
    ctx.modelRoot.remove(binMesh);
    binMesh.geometry.dispose();
    binMesh = null;
  }
  if (binLabelMesh) {
    ctx.modelRoot.remove(binLabelMesh);
    binLabelMesh.geometry.dispose();
    binLabelMesh = null;
  }
  if (!props.meshes) return;
  binMesh = buildMeshObject(props.meshes.body, bodyMaterial);
  ctx.modelRoot.add(binMesh);
  if (props.meshes.label) {
    binLabelMesh = buildMeshObject(props.meshes.label, labelMaterial);
    ctx.modelRoot.add(binLabelMesh);
  }
}

function syncGhosts(ctx: ThreeSceneContext): void {
  const wanted = new Set(props.ghosts.map((ghost) => ghost.id));
  for (const [id, entry] of ghostEntries) {
    if (wanted.has(id)) continue;
    disposeGhost(ctx, entry);
    ghostEntries.delete(id);
    // A gizmo left attached to a deleted model would keep driving an object
    // that is no longer in the scene, and its helper would warn about it on
    // every frame, so it is detached here at the moment the mesh leaves.
    if (id === attachedId) {
      translateControls?.detach();
      rotateControls?.detach();
      attachedId = null;
    }
  }
  for (const ghost of props.ghosts) {
    const existing = ghostEntries.get(ghost.id);
    if (existing && existing.source === ghost.mesh) {
      // The gizmo is the authority on the model it is currently dragging, so
      // the placement echoed back through the props is not written over it.
      if (ghost.id === draggingId) continue;
      // Nothing moved, so the bounds still stand and nothing has to be
      // remeasured. The colour is settled by the paint pass below.
      if (samePlacement(placementOf(existing.mesh), ghost.placement)) continue;
      applyPlacement(existing.mesh, ghost.placement);
      refreshBounds(existing);
      emit('boundsChange', {
        id: ghost.id,
        placement: placementOf(existing.mesh),
        bounds: existing.bounds,
      });
      continue;
    }
    if (existing) {
      disposeGhost(ctx, existing);
      ghostEntries.delete(ghost.id);
    }
    // Built with the plain material and painted by the pass below, so a ghost
    // drawn for the first time takes its colour from the same one place.
    const mesh = buildMeshObject(ghost.mesh, ghostMaterials.plain);
    // Three's intrinsic ZYX Euler order equals the extrinsic XYZ order
    // Manifold.rotate documents, so the angles read off this object are the
    // angles the carve applies. Set before any placement is written.
    mesh.rotation.order = 'ZYX';
    applyPlacement(mesh, ghost.placement);
    ctx.modelRoot.add(mesh);
    const entry: GhostEntry = {
      mesh,
      source: ghost.mesh,
      bounds: ghostBounds(mesh),
      painted: null,
    };
    ghostEntries.set(ghost.id, entry);
    emit('boundsChange', {
      id: ghost.id,
      placement: placementOf(mesh),
      bounds: entry.bounds,
    });
    // A newly drawn ghost is a new object, so the gizmo is detached from the
    // mesh that just left the scene and pointed at the new one by the
    // selection sync that follows.
    if (ghost.id === attachedId) {
      translateControls?.detach();
      rotateControls?.detach();
      attachedId = null;
    }
  }
  paintGhosts();
}

function syncSelection(): void {
  if (props.selectedModelId === attachedId) return;
  attachedId = props.selectedModelId;
  const entry = attachedId === null ? undefined : ghostEntries.get(attachedId);
  if (!entry) {
    translateControls?.detach();
    rotateControls?.detach();
    return;
  }
  translateControls?.attach(entry.mesh);
  rotateControls?.attach(entry.mesh);
}

function entryIdOf(mesh: THREE.Object3D): string | null {
  for (const [id, entry] of ghostEntries) {
    if (entry.mesh === mesh) return id;
  }
  return null;
}

function movedPayload(id: string): CutoutGhostMoved | null {
  const entry = ghostEntries.get(id);
  if (!entry) return null;
  refreshBounds(entry);
  return { id, placement: placementOf(entry.mesh), bounds: entry.bounds };
}

/** Is either gizmo hovering a handle or mid-drag? Then the click is not a selection. */
function gizmoBusy(): boolean {
  return [translateControls, rotateControls].some(
    (instance) => instance !== null && (instance.dragging || instance.axis !== null),
  );
}

function onPointerDown(event: PointerEvent): void {
  pointerDownX = event.clientX;
  pointerDownY = event.clientY;
  pointerDownButton = event.button;
}

function selectAtPointer(ctx: ThreeSceneContext, event: PointerEvent): void {
  if (pointerDownButton !== 0 || event.button !== 0) return;
  const travelled = Math.hypot(event.clientX - pointerDownX, event.clientY - pointerDownY);
  if (travelled > CLICK_TOLERANCE_PX) return;
  if (gizmoBusy()) return;
  const rect = ctx.canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  pointerNdc.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointerNdc, ctx.camera);
  const meshes = [...ghostEntries.values()].map((entry) => entry.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  emit('update:selectedModelId', hits.length === 0 ? null : entryIdOf(hits[0].object));
}

/**
 * TransformControls has no pointercancel listener, so a touch interruption or
 * a browser gesture takeover can end a drag with no pointerup at all, leaving
 * dragging true and the orbit camera disabled for good, which reads as the app
 * having frozen. Forcing dragging false runs the same setter a normal release
 * runs, so this recovery path is the ordinary release path and cannot drift
 * from it.
 */
function releaseStuckDrag(): void {
  for (const instance of [translateControls, rotateControls]) {
    if (instance !== null && instance.dragging) instance.dragging = false;
  }
}

let onPointerUp: ((event: PointerEvent) => void) | null = null;

function wireGizmo(
  ctx: ThreeSceneContext,
  instance: TransformControls,
  other: () => TransformControls | null,
): void {
  instance.addEventListener('dragging-changed', (event) => {
    const dragging = event.value === true;
    // Whichever instance grabbed a handle disables both the orbit camera and
    // its sibling, so one press can never start two drags at once.
    ctx.controls.enabled = !dragging;
    const sibling = other();
    if (sibling) sibling.enabled = !dragging;
    if (dragging) {
      draggingId = attachedId;
      return;
    }
    const finished = draggingId;
    draggingId = null;
    if (finished === null) return;
    const moved = movedPayload(finished);
    if (moved) emit('placementCommit', moved);
  });
  instance.addEventListener('objectChange', () => {
    if (draggingId === null) return;
    const moved = movedPayload(draggingId);
    if (moved) emit('placementChange', moved);
  });
}

const container = ref<HTMLDivElement | null>(null);

useThreeScene(container, {
  onReady: (ctx) => {
    // The translate instance is constructed first deliberately. Both instances
    // listen on the same canvas and the browser delivers pointerdown in
    // registration order, so the one constructed first wins any overlap
    // between an arrow and an arc, and translation is the more common gesture.
    translateControls = new TransformControls(ctx.camera, ctx.canvas);
    rotateControls = new TransformControls(ctx.camera, ctx.canvas);
    rotateControls.setMode('rotate');
    rotateControls.setSize(ROTATE_GIZMO_SIZE);

    // TransformControls extends Controls, not Object3D, so the scene receives
    // the helper rather than the controls themselves.
    ctx.scene.add(translateControls.getHelper());
    ctx.scene.add(rotateControls.getHelper());

    wireGizmo(ctx, translateControls, () => rotateControls);
    wireGizmo(ctx, rotateControls, () => translateControls);

    onPointerUp = (event: PointerEvent) => selectAtPointer(ctx, event);
    ctx.canvas.addEventListener('pointerdown', onPointerDown);
    ctx.canvas.addEventListener('pointerup', onPointerUp);
    ctx.canvas.addEventListener('pointercancel', releaseStuckDrag);
    ctx.canvas.addEventListener('lostpointercapture', releaseStuckDrag);

    syncBin(ctx);
    syncGhosts(ctx);
    syncSelection();
  },
  onFrame: (ctx) => {
    syncBin(ctx);
    syncGhosts(ctx);
    syncSelection();
  },
  onTeardown: (ctx) => {
    ctx.canvas.removeEventListener('pointerdown', onPointerDown);
    if (onPointerUp) ctx.canvas.removeEventListener('pointerup', onPointerUp);
    ctx.canvas.removeEventListener('pointercancel', releaseStuckDrag);
    ctx.canvas.removeEventListener('lostpointercapture', releaseStuckDrag);
    onPointerUp = null;
    for (const instance of [translateControls, rotateControls]) {
      if (!instance) continue;
      instance.detach();
      // dispose() releases the helper's own resources but does not take it out
      // of the scene, so the removal has to come first.
      ctx.scene.remove(instance.getHelper());
      instance.dispose();
    }
    translateControls = null;
    rotateControls = null;
    for (const entry of ghostEntries.values()) disposeGhost(ctx, entry);
    ghostEntries.clear();
    binMesh?.geometry.dispose();
    binLabelMesh?.geometry.dispose();
    bodyMaterial.dispose();
    labelMaterial.dispose();
    for (const material of Object.values(ghostMaterials)) material.dispose();
  },
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
