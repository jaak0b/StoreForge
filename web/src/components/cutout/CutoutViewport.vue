<script setup lang="ts">
import { ref, watch } from 'vue';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { MeshData, PartMeshes } from '../../engine/gridfinity/types';
import type { MeshBounds } from '../../engine/cutout/cutoutMesh';
import type { ModelPlacement } from '../../engine/cutout/cutoutBin';
import { strokeToleranceMm } from '../../engine/cutout/cavityEdits';
import { assertNever, type Vec3Mm } from '../../engine/plan/types';
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
  /** The active paint tool, or null when the gizmo owns the pointer. */
  paintTool: 'add' | 'remove' | 'flatten' | null;
  /** Brush radius in mm, sizing the cursor and the ghost capsules. */
  brushRadiusMm: number;
  /** Flatten cut height in mm, sizing the flatten cursor's preview cylinder. */
  flattenHeightMm: number;
  /** Whether Ctrl+Z has an edit to undo, so the shortcut knows to claim the key. */
  canUndo: boolean;
  /** Whether Ctrl+Y has an edit to redo, so the shortcut knows to claim the key. */
  canRedo: boolean;
  /**
   * The eye button's own sticky toggle. Combined with Tab held (which is
   * temporary and tracked internally) to decide whether the model ghosts are
   * hidden, matching the trace canvas's "hold Tab or eye button" behaviour.
   */
  modelsHiddenButton: boolean;
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
  /** A brush stroke ended: the sampled hit points in bin-local mm. */
  strokeCommit: [points: Vec3Mm[]];
  /** A flatten click landed: the hit point and the clicked surface's outward unit normal. */
  flattenCommit: [centerMm: Vec3Mm, normalMm: Vec3Mm];
  /** A tool shortcut (B, E, S, V or Escape) picked the named tool, or null for pointer mode. */
  setTool: [tool: 'add' | 'remove' | 'flatten' | null];
  /** The [ or ] key stepped the brush radius by this signed amount in mm. */
  stepBrushRadius: [deltaMm: number];
  /** Ctrl+Z (or Cmd+Z) was pressed with an edit to undo. */
  undo: [];
  /** Ctrl+Y (or Cmd+Shift+Z) was pressed with an edit to redo. */
  redo: [];
  /** The "?" key was pressed outside a field, toggling the shortcut help popover. */
  toggleShortcutHelp: [];
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

/**
 * Geometry and materials for the paint-mode cursor and the stroke ghost
 * chain, created once per viewport instance and reused across every frame
 * and every stroke. The disc is modelled lying flat on Three's default Y
 * axis and rotated onto local Z, the up axis inside `modelRoot`; the flatten
 * cursor is then tilted per hit to the clicked surface's normal, so it always
 * lies flush with the surface it will level.
 */
const paintSphereGeometry = new THREE.SphereGeometry(1, 24, 16);
const paintCylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 16);
const paintDiscGeometry = new THREE.CylinderGeometry(1, 1, 0.2, 32);
paintDiscGeometry.rotateX(Math.PI / 2);

/**
 * The flatten cut preview pillar: a unit cylinder pre-translated so its base
 * sits at local origin instead of being centred on it, then rotated onto
 * local Z the same way the disc is. Scaling it (radiusMm, radiusMm, heightMm)
 * and giving it the disc's own position and orientation stands it on the
 * disc, base on the tangent plane, growing along the hit normal.
 */
const paintFlattenCylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 16);
paintFlattenCylinderGeometry.translate(0, 0.5, 0);
paintFlattenCylinderGeometry.rotateX(Math.PI / 2);

const paintCursorMaterial = createGhostMaterial(PRIMARY);
const strokeAddMaterial = createGhostMaterial(INFO);
const strokeRemoveMaterial = createGhostMaterial(ERROR);

/** The one cursor mesh the pointer drives; its geometry swaps with the tool. */
const paintCursorMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> = new THREE.Mesh(
  paintSphereGeometry,
  paintCursorMaterial,
);
paintCursorMesh.visible = false;

/**
 * The flatten cut preview pillar, shown alongside the disc only while the
 * flatten tool is active: it shares the disc's material and its position and
 * orientation on every update, so the two always read as one preview of the
 * cut the click would make.
 */
const paintFlattenCylinderMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> =
  new THREE.Mesh(paintFlattenCylinderGeometry, paintCursorMaterial);
paintFlattenCylinderMesh.visible = false;

const UNIT_Y = new THREE.Vector3(0, 1, 0);
const UNIT_Z = new THREE.Vector3(0, 0, 1);
const strokeDirection = new THREE.Vector3();
const paintLocalPoint = new THREE.Vector3();
const paintLocalNormal = new THREE.Vector3();
const paintNormalMatrix = new THREE.Matrix3();

let strokeActive = false;
let strokePoints: Vec3Mm[] = [];
const strokeGhostMeshes: THREE.Mesh[] = [];

let binMesh: THREE.Mesh | null = null;
let binLabelMesh: THREE.Mesh | null = null;
let drawnMeshes: PartMeshes | null = null;

const ghostEntries = new Map<string, GhostEntry>();

/**
 * True while Tab is held, hiding every model ghost mesh so the carved bin
 * surface underneath is visible and paintable (the Flatten tool otherwise
 * has to work through the translucent ghost sitting in front of the cavity).
 * Selection and warning colours are untouched: only visibility changes, so
 * releasing Tab shows exactly the ghosts that were there before, in the
 * tones the paint pass already keeps current.
 */
const tabHeld = ref(false);

/** True when focus sits in a field where Tab and the shortcut keys are ordinary input. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

/**
 * Applies the current hidden state to every drawn ghost mesh. Called after
 * every ghost sync (so a ghost rebuilt while hidden comes in hidden), on every
 * Tab keydown/keyup, and whenever the eye button's sticky toggle changes.
 * Either Tab held or the eye button hides the ghosts, matching the trace
 * canvas's "hold Tab or eye button" behaviour.
 */
function applyGhostVisibility(): void {
  const hidden = tabHeld.value || props.modelsHiddenButton;
  for (const entry of ghostEntries.values()) {
    entry.mesh.visible = !hidden;
  }
}

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
  }
  paintGhosts();
  applyGhostVisibility();
  syncGizmo();
}

/**
 * The single source of gizmo attachment. Desired attachment is a pure function
 * of the selection, the paint tool and the drawn ghosts; this reconciles the
 * live controls to it and is safe to call after any change that can affect it.
 */
function syncGizmo(): void {
  if (!translateControls || !rotateControls) return;
  const enabled = props.paintTool === null;
  translateControls.enabled = enabled;
  rotateControls.enabled = enabled;
  const desiredMesh =
    enabled && props.selectedModelId !== null
      ? (ghostEntries.get(props.selectedModelId)?.mesh ?? null)
      : null;
  if ((translateControls.object ?? null) === desiredMesh) return;
  if (desiredMesh === null) {
    translateControls.detach();
    rotateControls.detach();
    attachedId = null;
  } else {
    translateControls.attach(desiredMesh);
    rotateControls.attach(desiredMesh);
    attachedId = props.selectedModelId;
  }
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
  if (props.paintTool !== null) return;
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
let onPointerMove: ((event: PointerEvent) => void) | null = null;
let onPointerDownPaintHandler: ((event: PointerEvent) => void) | null = null;
let onPointerUpPaintHandler: ((event: PointerEvent) => void) | null = null;
let onKeyDown: ((event: KeyboardEvent) => void) | null = null;
let onKeyUp: ((event: KeyboardEvent) => void) | null = null;

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

/** Hide the paint cursor. */
function hidePaintCursor(): void {
  paintCursorMesh.visible = false;
  paintFlattenCylinderMesh.visible = false;
}

/**
 * Raycasts against the carved bin only (never the ghosts), returning the hit
 * point in bin-local mm. Also fills `paintLocalNormal` with the clicked
 * surface's outward unit normal, transformed from the hit face's own local
 * space into modelRoot/bin-local space by its normal matrix. Returns the same
 * scratch vector on every call; the caller must consume it (and the normal)
 * before the next raycast.
 */
function raycastPaintHit(ctx: ThreeSceneContext, event: PointerEvent): THREE.Vector3 | null {
  const rect = ctx.canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  pointerNdc.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointerNdc, ctx.camera);
  const targets: THREE.Mesh[] = [];
  if (binMesh) targets.push(binMesh);
  if (binLabelMesh) targets.push(binLabelMesh);
  if (targets.length === 0) return null;
  const hits = raycaster.intersectObjects(targets, false);
  if (hits.length === 0) return null;
  const hit = hits[0];
  const face = hit.face;
  if (!face) return null;
  paintLocalPoint.copy(hit.point);
  ctx.modelRoot.worldToLocal(paintLocalPoint);
  // hit.object is a direct child of modelRoot with an identity local
  // transform (buildMeshObject sets no position/rotation/scale of its own),
  // so its own .matrix already carries the face normal into modelRoot-local
  // space with no further composition needed.
  paintNormalMatrix.getNormalMatrix(hit.object.matrix);
  paintLocalNormal.copy(face.normal).applyMatrix3(paintNormalMatrix).normalize();
  return paintLocalPoint;
}

/** Point the reused sphere cursor at the hit, sized to the brush radius. */
function showBrushCursor(hit: THREE.Vector3): void {
  paintCursorMesh.geometry = paintSphereGeometry;
  paintCursorMesh.scale.setScalar(props.brushRadiusMm);
  paintCursorMesh.position.copy(hit);
  paintCursorMesh.visible = true;
  paintFlattenCylinderMesh.visible = false;
}

/**
 * Point the reused disc cursor at the hit, tilted flush with the clicked
 * surface, and stand the reused cut-height pillar on it along the same
 * normal: together they preview exactly the material a flatten click there
 * would remove.
 */
function showFlattenCursor(hit: THREE.Vector3): void {
  paintCursorMesh.geometry = paintDiscGeometry;
  paintCursorMesh.scale.set(props.brushRadiusMm, props.brushRadiusMm, 1);
  paintCursorMesh.position.copy(hit);
  paintCursorMesh.quaternion.setFromUnitVectors(UNIT_Z, paintLocalNormal);
  paintCursorMesh.visible = true;
  paintFlattenCylinderMesh.scale.set(props.brushRadiusMm, props.brushRadiusMm, props.flattenHeightMm);
  paintFlattenCylinderMesh.position.copy(hit);
  paintFlattenCylinderMesh.quaternion.copy(paintCursorMesh.quaternion);
  paintFlattenCylinderMesh.visible = true;
}

/** Remove and forget every ghost mesh drawn for the stroke in progress. */
function clearStrokeGhosts(ctx: ThreeSceneContext): void {
  for (const mesh of strokeGhostMeshes) ctx.modelRoot.remove(mesh);
  strokeGhostMeshes.length = 0;
}

/**
 * Draws one sphere at the new point and, when a previous point exists, a
 * cylinder segment between the two: the capsule chain that stands in for the
 * eventual carve while the stroke is still a drag.
 */
function addStrokeGhostPoint(
  ctx: ThreeSceneContext,
  tool: 'add' | 'remove',
  point: Vec3Mm,
  previous: Vec3Mm | null,
): void {
  const material = tool === 'add' ? strokeAddMaterial : strokeRemoveMaterial;
  const sphere = new THREE.Mesh(paintSphereGeometry, material);
  sphere.scale.setScalar(props.brushRadiusMm);
  sphere.position.set(point.xMm, point.yMm, point.zMm);
  ctx.modelRoot.add(sphere);
  strokeGhostMeshes.push(sphere);
  if (!previous) return;
  const dx = point.xMm - previous.xMm;
  const dy = point.yMm - previous.yMm;
  const dz = point.zMm - previous.zMm;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return;
  const cylinder = new THREE.Mesh(paintCylinderGeometry, material);
  cylinder.scale.set(props.brushRadiusMm, length, props.brushRadiusMm);
  cylinder.position.set(
    (point.xMm + previous.xMm) / 2,
    (point.yMm + previous.yMm) / 2,
    (point.zMm + previous.zMm) / 2,
  );
  strokeDirection.set(dx, dy, dz).normalize();
  cylinder.quaternion.setFromUnitVectors(UNIT_Y, strokeDirection);
  ctx.modelRoot.add(cylinder);
  strokeGhostMeshes.push(cylinder);
}

/**
 * Appends the hit to the stroke's sampled points when it moved far enough
 * from the last sample, and draws the ghost for the new point. The tolerance
 * is the stroke figure the engine already derives from the brush radius, not
 * a separate constant guessed here.
 */
function sampleStroke(ctx: ThreeSceneContext, tool: 'add' | 'remove', hit: THREE.Vector3): void {
  const last = strokePoints[strokePoints.length - 1] ?? null;
  if (last) {
    const dx = hit.x - last.xMm;
    const dy = hit.y - last.yMm;
    const dz = hit.z - last.zMm;
    if (Math.hypot(dx, dy, dz) < strokeToleranceMm(props.brushRadiusMm)) return;
  }
  const point: Vec3Mm = { xMm: hit.x, yMm: hit.y, zMm: hit.z };
  strokePoints.push(point);
  addStrokeGhostPoint(ctx, tool, point, last);
}

/**
 * Tracks the cursor across the bin surface while a paint tool is active, and
 * samples the stroke when one is in progress. Exhaustive over the tool union
 * plus null, per the union-switch convention.
 */
function onPointerMovePaint(ctx: ThreeSceneContext, event: PointerEvent): void {
  const tool = props.paintTool;
  switch (tool) {
    case null:
      hidePaintCursor();
      return;
    case 'add':
    case 'remove': {
      const hit = raycastPaintHit(ctx, event);
      if (!hit) {
        hidePaintCursor();
        return;
      }
      showBrushCursor(hit);
      if (strokeActive) sampleStroke(ctx, tool, hit);
      return;
    }
    case 'flatten': {
      const hit = raycastPaintHit(ctx, event);
      if (!hit) {
        hidePaintCursor();
        return;
      }
      showFlattenCursor(hit);
      return;
    }
    default:
      assertNever(tool);
  }
}

/** Starts an add/remove stroke on a left press with a hit; flatten commits on release instead. */
function onPointerDownPaint(ctx: ThreeSceneContext, event: PointerEvent): void {
  const tool = props.paintTool;
  if (tool === null || tool === 'flatten') return;
  if (event.button !== 0) return;
  const hit = raycastPaintHit(ctx, event);
  if (!hit) return;
  ctx.canvas.setPointerCapture(event.pointerId);
  ctx.controls.enabled = false;
  strokeActive = true;
  strokePoints = [];
  clearStrokeGhosts(ctx);
  sampleStroke(ctx, tool, hit);
}

/**
 * Ends an add/remove stroke, clearing the ghosts and committing the sampled
 * points; or, for flatten, treats a click within the travel tolerance as the
 * commit. Exhaustive over the tool union plus null.
 */
function onPointerUpPaint(ctx: ThreeSceneContext, event: PointerEvent): void {
  const tool = props.paintTool;
  switch (tool) {
    case null:
      return;
    case 'add':
    case 'remove': {
      if (!strokeActive) return;
      strokeActive = false;
      ctx.controls.enabled = true;
      clearStrokeGhosts(ctx);
      const points = strokePoints;
      strokePoints = [];
      if (points.length > 0) emit('strokeCommit', points);
      return;
    }
    case 'flatten': {
      if (pointerDownButton !== 0 || event.button !== 0) return;
      const travelled = Math.hypot(event.clientX - pointerDownX, event.clientY - pointerDownY);
      if (travelled > CLICK_TOLERANCE_PX) return;
      const hit = raycastPaintHit(ctx, event);
      if (!hit) return;
      emit(
        'flattenCommit',
        { xMm: hit.x, yMm: hit.y, zMm: hit.z },
        { xMm: paintLocalNormal.x, yMm: paintLocalNormal.y, zMm: paintLocalNormal.z },
      );
      return;
    }
    default:
      assertNever(tool);
  }
}

/**
 * The step, in mm, that the [ and ] keys move the brush radius by. Matches
 * the trace canvas's own bracket-key step for its (differently ranged) brush
 * size; the store clamps the result to the cavity edit radius bounds, so this
 * component never has to know them.
 */
const BRUSH_RADIUS_STEP_MM = 1;

/**
 * The viewport's own keyboard shortcuts: Tab held hides the ghosts, "?"
 * toggles the shortcut help popover, Ctrl+Z (or Cmd+Z) undoes and Ctrl+Y (or
 * Cmd+Y, or Cmd+Shift+Z on mac) redoes, B/E/S pick the paint tools, V or
 * Escape returns to pointer mode, and [ and ] step the brush radius. None of
 * these fire while focus sits in a field.
 */
function onKeyDownGlobal(event: KeyboardEvent): void {
  if (event.key === 'Tab') {
    if (isEditableTarget(event.target)) return;
    if (!event.repeat) {
      tabHeld.value = true;
      applyGhostVisibility();
    }
    event.preventDefault();
    return;
  }
  if (isEditableTarget(event.target)) return;
  if (event.key === '?') {
    emit('toggleShortcutHelp');
    event.preventDefault();
    return;
  }
  const key = event.key;
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && (key === 'z' || key === 'Z') && !event.shiftKey) {
    if (props.canUndo) {
      emit('undo');
      event.preventDefault();
    }
    return;
  }
  if (modifier && ((key === 'y' || key === 'Y') || (event.shiftKey && (key === 'z' || key === 'Z')))) {
    if (props.canRedo) {
      emit('redo');
      event.preventDefault();
    }
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  switch (key) {
    case 'b':
    case 'B':
      emit('setTool', 'add');
      break;
    case 'e':
    case 'E':
      emit('setTool', 'remove');
      break;
    case 's':
    case 'S':
      emit('setTool', 'flatten');
      break;
    case 'v':
    case 'V':
    case 'Escape':
      if (props.paintTool === null) return;
      emit('setTool', null);
      break;
    case '[':
      emit('stepBrushRadius', -BRUSH_RADIUS_STEP_MM);
      break;
    case ']':
      emit('stepBrushRadius', BRUSH_RADIUS_STEP_MM);
      break;
    default:
      return;
  }
  event.preventDefault();
}

/** Tab release restores every ghost's visibility to what the paint pass already decided. */
function onKeyUpGlobal(event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;
  tabHeld.value = false;
  applyGhostVisibility();
  if (!isEditableTarget(event.target)) event.preventDefault();
}

const container = ref<HTMLDivElement | null>(null);

const { context } = useThreeScene(container, {
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
    onPointerMove = (event: PointerEvent) => onPointerMovePaint(ctx, event);
    onPointerDownPaintHandler = (event: PointerEvent) => onPointerDownPaint(ctx, event);
    onPointerUpPaintHandler = (event: PointerEvent) => onPointerUpPaint(ctx, event);
    onKeyDown = (event: KeyboardEvent) => onKeyDownGlobal(event);
    onKeyUp = (event: KeyboardEvent) => onKeyUpGlobal(event);
    ctx.canvas.addEventListener('pointerdown', onPointerDown);
    ctx.canvas.addEventListener('pointerup', onPointerUp);
    ctx.canvas.addEventListener('pointercancel', releaseStuckDrag);
    ctx.canvas.addEventListener('lostpointercapture', releaseStuckDrag);
    ctx.canvas.addEventListener('pointermove', onPointerMove);
    ctx.canvas.addEventListener('pointerdown', onPointerDownPaintHandler);
    ctx.canvas.addEventListener('pointerup', onPointerUpPaintHandler);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    ctx.modelRoot.add(paintCursorMesh);
    ctx.modelRoot.add(paintFlattenCylinderMesh);

    syncBin(ctx);
    syncGhosts(ctx);
    syncGizmo();
  },
  onTeardown: (ctx) => {
    ctx.canvas.removeEventListener('pointerdown', onPointerDown);
    if (onPointerUp) ctx.canvas.removeEventListener('pointerup', onPointerUp);
    ctx.canvas.removeEventListener('pointercancel', releaseStuckDrag);
    ctx.canvas.removeEventListener('lostpointercapture', releaseStuckDrag);
    if (onPointerMove) ctx.canvas.removeEventListener('pointermove', onPointerMove);
    if (onPointerDownPaintHandler) {
      ctx.canvas.removeEventListener('pointerdown', onPointerDownPaintHandler);
    }
    if (onPointerUpPaintHandler) ctx.canvas.removeEventListener('pointerup', onPointerUpPaintHandler);
    if (onKeyDown) window.removeEventListener('keydown', onKeyDown);
    if (onKeyUp) window.removeEventListener('keyup', onKeyUp);
    onPointerUp = null;
    onPointerMove = null;
    onPointerDownPaintHandler = null;
    onPointerUpPaintHandler = null;
    onKeyDown = null;
    onKeyUp = null;
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
    clearStrokeGhosts(ctx);
    ctx.modelRoot.remove(paintCursorMesh);
    ctx.modelRoot.remove(paintFlattenCylinderMesh);
    binMesh?.geometry.dispose();
    binLabelMesh?.geometry.dispose();
    bodyMaterial.dispose();
    labelMaterial.dispose();
    for (const material of Object.values(ghostMaterials)) material.dispose();
    paintSphereGeometry.dispose();
    paintCylinderGeometry.dispose();
    paintDiscGeometry.dispose();
    paintFlattenCylinderGeometry.dispose();
    paintCursorMaterial.dispose();
    strokeAddMaterial.dispose();
    strokeRemoveMaterial.dispose();
  },
});

/**
 * Reconciling the scene with the props is reactive work, not frame work: the
 * bin mesh, the ghost list and the gizmo attachment each change only when a
 * prop does, so a watcher runs them exactly then rather than the render loop
 * re-deriving them sixty times a second. Every handler guards on the scene
 * existing, because a prop can settle before onReady has built it; onReady runs
 * the same three syncs once so the first paint is not left to a prop changing.
 *
 * What genuinely needs the frame loop stays there: the gizmo follows the model
 * it drags through TransformControls itself, and the dragged ghost is skipped
 * in syncGhosts so the placement echoed back through the props never fights the
 * handle. The render loop that draws all of it lives in useThreeScene.
 */
watch(
  () => props.meshes,
  () => {
    const ctx = context.value;
    if (ctx) syncBin(ctx);
  },
);
watch(
  () => props.ghosts,
  () => {
    const ctx = context.value;
    if (ctx) syncGhosts(ctx);
  },
);
watch(
  () => props.selectedModelId,
  () => {
    if (!context.value) return;
    syncGizmo();
    // The selection tone is settled here rather than in syncGizmo: the
    // ghost that lost the selection and the one that gained it both change
    // colour, and neither changed the ghost list that syncGhosts repaints from.
    paintGhosts();
    applyGhostVisibility();
  },
);
watch(
  () => props.warnedModelIds,
  () => {
    if (context.value) paintGhosts();
  },
  { deep: true },
);
/** The eye button's sticky toggle combines with Tab held; either hides the ghosts. */
watch(
  () => props.modelsHiddenButton,
  () => applyGhostVisibility(),
);

/**
 * While a paint tool is active, both gizmos let go of whatever they held so a
 * drag never fights a stroke, and any stroke already in flight (a tool
 * switch mid-drag) is abandoned rather than left to commit half-drawn.
 * Returning to null hands the gizmos back to the current selection.
 */
watch(
  () => props.paintTool,
  (tool) => {
    const ctx = context.value;
    if (tool !== null) {
      strokeActive = false;
      strokePoints = [];
      if (ctx) clearStrokeGhosts(ctx);
      hidePaintCursor();
      if (ctx) ctx.controls.enabled = true;
    }
    syncGizmo();
  },
  { immediate: true },
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
