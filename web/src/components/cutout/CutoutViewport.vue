<script setup lang="ts">
import { ref, watch } from 'vue';
import * as THREE from 'three';
import type { PartMeshes } from '../../engine/gridfinity/types';
import { strokeToleranceMm } from '../../engine/carve/cavityEdits';
import { assertNever, type Vec3Mm } from '../../engine/plan/types';
import { ERROR, INFO, PRIMARY } from '../../themeColors';
import type { CutoutGhost, CutoutGhostMoved } from './cutoutGhost';
import {
  createGhostMaterial,
  useThreeScene,
  type ThreeSceneContext,
} from '../../composables/useThreeScene';
import { useBinMesh } from '../../composables/useBinMesh';
import { CLICK_TOLERANCE_PX, useModelGizmo } from '../../composables/useModelGizmo';

/**
 * The cutout bin editor's viewport: the carved bin, the placed models drawn as
 * translucent ghosts, and the gizmo that moves and turns the selected one, plus
 * the cavity paint tools.
 *
 * It is the base viewport (scene, camera, orbit, lighting, grid, bin mesh) with
 * two layers composed on top. The scene scaffolding lives in `useThreeScene`,
 * the bin body and label in `useBinMesh`, and the ghosts and gizmo in
 * `useModelGizmo`; what stays here is the paint layer and the one place that
 * arbitrates a gizmo drag, a paint stroke and the orbit camera against each
 * other.
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

const container = ref<HTMLDivElement | null>(null);

/** The base bin body and label. Its body mesh is what the paint tools raycast against. */
const binDisplay = useBinMesh();

/**
 * The ghosts and gizmo layer. Its hidden state is either Tab held (a paint-side
 * concern tracked here) or the eye button, matching the trace canvas.
 */
const gizmo = useModelGizmo({
  ghosts: () => props.ghosts,
  selectedModelId: () => props.selectedModelId,
  warnedModelIds: () => props.warnedModelIds,
  paintActive: () => props.paintTool !== null,
  modelsHidden: () => tabHeld.value || props.modelsHiddenButton,
  onSelect: (id) => emit('update:selectedModelId', id),
  onPlacementChange: (moved) => emit('placementChange', moved),
  onPlacementCommit: (moved) => emit('placementCommit', moved),
  onBoundsChange: (moved) => emit('boundsChange', moved),
});

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

/** The paint layer's own raycaster; the gizmo's selection uses its own. */
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

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

let pointerDownX = 0;
let pointerDownY = 0;
let pointerDownButton = -1;

function onPointerDown(event: PointerEvent): void {
  pointerDownX = event.clientX;
  pointerDownY = event.clientY;
  pointerDownButton = event.button;
}

/**
 * Abandons the paint stroke in progress WITHOUT committing it: the sampled
 * points and their ghost preview meshes are discarded and the orbit camera is
 * handed back. The one place a stroke is torn down without emitting it, shared
 * so the recovery paths cannot drift from each other. It runs both when a
 * pointercancel or lostpointercapture ends a drag with no pointerup (a browser
 * gesture takeover, which would otherwise leave the stroke active and the
 * camera disabled for good) and when the tool is switched mid-stroke.
 */
function abortStroke(ctx: ThreeSceneContext): void {
  if (!strokeActive) return;
  strokeActive = false;
  strokePoints = [];
  clearStrokeGhosts(ctx);
  ctx.controls.enabled = true;
}

let onPointerUp: ((event: PointerEvent) => void) | null = null;
let onPointerMove: ((event: PointerEvent) => void) | null = null;
let onPointerDownPaintHandler: ((event: PointerEvent) => void) | null = null;
let onPointerUpPaintHandler: ((event: PointerEvent) => void) | null = null;
let onPointerCancelRecovery: ((event: PointerEvent) => void) | null = null;
let onKeyDown: ((event: KeyboardEvent) => void) | null = null;
let onKeyUp: ((event: KeyboardEvent) => void) | null = null;
let onWindowBlur: (() => void) | null = null;

/** Hide the paint cursor. */
function hidePaintCursor(): void {
  paintCursorMesh.visible = false;
  paintFlattenCylinderMesh.visible = false;
}

/**
 * Raycasts against the carved bin body only (never the ghosts, and never the
 * label), returning the hit point in bin-local mm. Cavity edits apply to the
 * body alone, so a click that only meets the label geometry is a no-op rather
 * than a confusing edit against a surface no carve touches. Also fills
 * `paintLocalNormal` with the clicked surface's outward unit normal,
 * transformed from the hit face's own local space into modelRoot/bin-local
 * space by its normal matrix. Returns the same scratch vector on every call;
 * the caller must consume it (and the normal) before the next raycast.
 */
function raycastPaintHit(ctx: ThreeSceneContext, event: PointerEvent): THREE.Vector3 | null {
  const rect = ctx.canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  pointerNdc.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointerNdc, ctx.camera);
  const body = binDisplay.bodyMesh;
  if (!body) return null;
  const hits = raycaster.intersectObjects([body], false);
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
      gizmo.applyGhostVisibility();
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
  gizmo.applyGhostVisibility();
  if (!isEditableTarget(event.target)) event.preventDefault();
}

/**
 * Losing the window (Alt+Tab, a click into another app) never delivers the Tab
 * keyup, so the held state is cleared here instead, restoring every ghost's
 * visibility exactly as the keyup would.
 */
function onWindowBlurGlobal(): void {
  if (!tabHeld.value) return;
  tabHeld.value = false;
  gizmo.applyGhostVisibility();
}

const { context } = useThreeScene(container, {
  onReady: (ctx) => {
    gizmo.setup(ctx);

    onPointerUp = (event: PointerEvent) =>
      gizmo.selectAtPointer(ctx, event, {
        button: pointerDownButton,
        x: pointerDownX,
        y: pointerDownY,
      });
    onPointerMove = (event: PointerEvent) => onPointerMovePaint(ctx, event);
    onPointerDownPaintHandler = (event: PointerEvent) => onPointerDownPaint(ctx, event);
    onPointerUpPaintHandler = (event: PointerEvent) => onPointerUpPaint(ctx, event);
    // One recovery path for both an interrupted gizmo drag and an interrupted
    // paint stroke: the same pointercancel/lostpointercapture that leaves a
    // gizmo drag stuck also leaves a stroke stuck, so both are released here.
    onPointerCancelRecovery = () => {
      gizmo.releaseStuckDrag();
      abortStroke(ctx);
    };
    onKeyDown = (event: KeyboardEvent) => onKeyDownGlobal(event);
    onKeyUp = (event: KeyboardEvent) => onKeyUpGlobal(event);
    // Alt+Tab away loses the Tab keyup, so the blur that comes with it is what
    // clears the held state; without it the ghosts would stay hidden until Tab
    // was pressed and released again.
    onWindowBlur = () => onWindowBlurGlobal();
    ctx.canvas.addEventListener('pointerdown', onPointerDown);
    ctx.canvas.addEventListener('pointerup', onPointerUp);
    ctx.canvas.addEventListener('pointercancel', onPointerCancelRecovery);
    ctx.canvas.addEventListener('lostpointercapture', onPointerCancelRecovery);
    ctx.canvas.addEventListener('pointermove', onPointerMove);
    ctx.canvas.addEventListener('pointerdown', onPointerDownPaintHandler);
    ctx.canvas.addEventListener('pointerup', onPointerUpPaintHandler);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);

    ctx.modelRoot.add(paintCursorMesh);
    ctx.modelRoot.add(paintFlattenCylinderMesh);

    binDisplay.sync(ctx, props.meshes?.body ?? null, props.meshes?.label ?? null);
    gizmo.syncGhosts(ctx);
    gizmo.syncGizmo();
  },
  onTeardown: (ctx) => {
    ctx.canvas.removeEventListener('pointerdown', onPointerDown);
    if (onPointerUp) ctx.canvas.removeEventListener('pointerup', onPointerUp);
    if (onPointerCancelRecovery) {
      ctx.canvas.removeEventListener('pointercancel', onPointerCancelRecovery);
      ctx.canvas.removeEventListener('lostpointercapture', onPointerCancelRecovery);
    }
    if (onPointerMove) ctx.canvas.removeEventListener('pointermove', onPointerMove);
    if (onPointerDownPaintHandler) {
      ctx.canvas.removeEventListener('pointerdown', onPointerDownPaintHandler);
    }
    if (onPointerUpPaintHandler) ctx.canvas.removeEventListener('pointerup', onPointerUpPaintHandler);
    if (onKeyDown) window.removeEventListener('keydown', onKeyDown);
    if (onKeyUp) window.removeEventListener('keyup', onKeyUp);
    if (onWindowBlur) window.removeEventListener('blur', onWindowBlur);
    onPointerUp = null;
    onPointerMove = null;
    onPointerDownPaintHandler = null;
    onPointerUpPaintHandler = null;
    onPointerCancelRecovery = null;
    onKeyDown = null;
    onKeyUp = null;
    onWindowBlur = null;

    gizmo.teardown(ctx);
    binDisplay.dispose(ctx);

    clearStrokeGhosts(ctx);
    ctx.modelRoot.remove(paintCursorMesh);
    ctx.modelRoot.remove(paintFlattenCylinderMesh);
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
 * the same syncs once so the first paint is not left to a prop changing.
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
    if (ctx) binDisplay.sync(ctx, props.meshes?.body ?? null, props.meshes?.label ?? null);
  },
);
watch(
  () => props.ghosts,
  () => {
    const ctx = context.value;
    if (ctx) gizmo.syncGhosts(ctx);
  },
);
watch(
  () => props.selectedModelId,
  () => {
    if (!context.value) return;
    gizmo.syncGizmo();
    // The selection tone is settled here rather than in syncGizmo: the
    // ghost that lost the selection and the one that gained it both change
    // colour, and neither changed the ghost list that syncGhosts repaints from.
    gizmo.paintGhosts();
    gizmo.applyGhostVisibility();
  },
);
watch(
  () => props.warnedModelIds,
  () => {
    if (context.value) gizmo.paintGhosts();
  },
  { deep: true },
);
/** The eye button's sticky toggle combines with Tab held; either hides the ghosts. */
watch(
  () => props.modelsHiddenButton,
  () => gizmo.applyGhostVisibility(),
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
      if (ctx) abortStroke(ctx);
      hidePaintCursor();
    }
    gizmo.syncGizmo();
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
