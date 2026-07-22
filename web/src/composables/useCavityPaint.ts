import { ref } from 'vue';
import * as THREE from 'three';
import { strokeToleranceMm } from '../engine/carve/cavityEdits';
import { assertNever, type Vec3Mm } from '../engine/plan/types';
import { ERROR, INFO, PRIMARY } from '../themeColors';
import { createGhostMaterial, type ThreeSceneContext } from './useThreeScene';
import { CLICK_TOLERANCE_PX } from './useModelGizmo';
import type { CavityTool } from '../stores/cavityEditSession';

/**
 * The cavity paint layer shared by every carved-interior bin viewport: the
 * brush cursor, the raycast stroke sampling against the drawn bin body, the
 * add/remove stroke accumulation and its ghost preview, the flatten click with
 * its surface-normal capture, and the paint keyboard shortcuts. Extracted from
 * the cutout viewport so the traced tool bin paints with the exact same
 * semantics rather than a second copy (rule 10).
 *
 * Imperative like useModelGizmo: the caller passes getters for the reactive
 * state it reads (the active tool, the brush and flatten sizes, the mesh to
 * raycast) and callbacks for the events it raises (a committed stroke, a
 * flatten click, a tool pick, a radius step, undo, redo, the help toggle). It
 * owns the paint listeners through setup/teardown and exposes abortStroke and
 * the pointer-down state so the consumer can arbitrate the stroke against a
 * gizmo drag and the orbit camera at the one place that owns that ordering.
 */

/** The pointer-press position a select-on-release test measures travel against. */
export interface PaintPointerDownState {
  button: number;
  x: number;
  y: number;
}

export interface CavityPaintOptions {
  /** The active paint tool, or null when nothing is being painted. */
  paintTool: () => CavityTool | null;
  /** Brush radius in mm, sizing the cursor and the stroke capsules. */
  brushRadiusMm: () => number;
  /** Flatten cut height in mm, sizing the flatten cursor's preview pillar. */
  flattenHeightMm: () => number;
  /** Whether an undo shortcut has an edit to claim the key for. */
  canUndo: () => boolean;
  /** Whether a redo shortcut has an edit to claim the key for. */
  canRedo: () => boolean;
  /** The bin body mesh to raycast against, or null before a carve has landed. */
  bodyMesh: () => THREE.Mesh | null;
  /** A brush stroke ended: the sampled hit points in bin-local mm. */
  onStrokeCommit: (points: Vec3Mm[]) => void;
  /** A flatten click landed: the hit point and the clicked surface's outward unit normal. */
  onFlattenCommit: (centerMm: Vec3Mm, normalMm: Vec3Mm) => void;
  /** A tool shortcut (B, E, S, V or Escape) picked the named tool, or null. */
  onSetTool: (tool: CavityTool | null) => void;
  /** The [ or ] key stepped the brush radius by this signed amount in mm. */
  onStepBrushRadius: (deltaMm: number) => void;
  /** An undo shortcut fired with an edit to undo. */
  onUndo: () => void;
  /** A redo shortcut fired with an edit to redo. */
  onRedo: () => void;
  /** The "?" key was pressed outside a field, toggling the shortcut help popover. */
  onToggleShortcutHelp: () => void;
  /**
   * Called when Tab-held changes, if the consumer draws something the held key
   * hides. The cutout viewport uses it to hide the model ghosts; a viewport
   * with nothing to hide leaves it unset.
   */
  onTabHeldChange?: () => void;
}

/**
 * The paint options a parent binds, minus the body mesh: a display viewport
 * supplies the mesh from its own useBinMesh, so a consumer that hands paint to
 * such a viewport passes everything but that.
 */
export type CavityPaintBinding = Omit<CavityPaintOptions, 'bodyMesh'>;

export interface CavityPaint {
  /** Add the paint listeners and cursor meshes. Call from the scene's onReady. */
  setup(ctx: ThreeSceneContext): void;
  /** Remove the listeners and dispose the cursor meshes and materials. Call from onTeardown. */
  teardown(ctx: ThreeSceneContext): void;
  /** Abandon the stroke in progress without committing it, handing back the camera. */
  abortStroke(ctx: ThreeSceneContext): void;
  /** Hide the paint cursor. */
  hidePaintCursor(): void;
  /** The last pointer-down button and position, for a consumer's select-on-release test. */
  pointerDownState(): PaintPointerDownState;
  /** True while Tab is held. */
  tabHeld(): boolean;
}

/**
 * The step, in mm, that the [ and ] keys move the brush radius by. Matches the
 * trace canvas's own bracket-key step; the session clamps the result to the
 * cavity edit radius bounds, so this layer never has to know them.
 */
const BRUSH_RADIUS_STEP_MM = 1;

/** True when focus sits in a field where Tab and the shortcut keys are ordinary input. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

export function useCavityPaint(options: CavityPaintOptions): CavityPaint {
  /**
   * Geometry and materials for the paint-mode cursor and the stroke ghost
   * chain, created once per viewport instance and reused across every frame
   * and every stroke. The disc is modelled lying flat on Three's default Y
   * axis and rotated onto local Z, the up axis inside modelRoot; the flatten
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
  const paintCursorMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> =
    new THREE.Mesh(paintSphereGeometry, paintCursorMaterial);
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

  /** The paint layer's own raycaster; a gizmo selection uses its own. */
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();

  /**
   * True while Tab is held. A viewport that draws ghosts hides them while it is
   * true; a viewport without ghosts still tracks it so releasing Tab restores
   * whatever the consumer's onTabHeldChange settled.
   */
  const tabHeld = ref(false);

  let pointerDownX = 0;
  let pointerDownY = 0;
  let pointerDownButton = -1;

  let onPointerDownHandler: ((event: PointerEvent) => void) | null = null;
  let onPointerMoveHandler: ((event: PointerEvent) => void) | null = null;
  let onPointerUpHandler: ((event: PointerEvent) => void) | null = null;
  let onKeyDown: ((event: KeyboardEvent) => void) | null = null;
  let onKeyUp: ((event: KeyboardEvent) => void) | null = null;
  let onWindowBlur: (() => void) | null = null;

  /** Hide the paint cursor. */
  function hidePaintCursor(): void {
    paintCursorMesh.visible = false;
    paintFlattenCylinderMesh.visible = false;
  }

  /**
   * Raycasts against the carved bin body only (never any ghost, and never the
   * label), returning the hit point in bin-local mm. Cavity edits apply to the
   * body alone, so a click that only meets the label geometry is a no-op rather
   * than a confusing edit against a surface no carve touches. Also fills
   * paintLocalNormal with the clicked surface's outward unit normal, transformed
   * from the hit face's own local space into modelRoot/bin-local space by its
   * normal matrix. Returns the same scratch vector on every call; the caller
   * must consume it (and the normal) before the next raycast.
   */
  function raycastPaintHit(ctx: ThreeSceneContext, event: PointerEvent): THREE.Vector3 | null {
    const rect = ctx.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, ctx.camera);
    const body = options.bodyMesh();
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
    paintCursorMesh.scale.setScalar(options.brushRadiusMm());
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
    const radiusMm = options.brushRadiusMm();
    paintCursorMesh.geometry = paintDiscGeometry;
    paintCursorMesh.scale.set(radiusMm, radiusMm, 1);
    paintCursorMesh.position.copy(hit);
    paintCursorMesh.quaternion.setFromUnitVectors(UNIT_Z, paintLocalNormal);
    paintCursorMesh.visible = true;
    paintFlattenCylinderMesh.scale.set(radiusMm, radiusMm, options.flattenHeightMm());
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
    const radiusMm = options.brushRadiusMm();
    const material = tool === 'add' ? strokeAddMaterial : strokeRemoveMaterial;
    const sphere = new THREE.Mesh(paintSphereGeometry, material);
    sphere.scale.setScalar(radiusMm);
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
    cylinder.scale.set(radiusMm, length, radiusMm);
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
      if (Math.hypot(dx, dy, dz) < strokeToleranceMm(options.brushRadiusMm())) return;
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
    const tool = options.paintTool();
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
    const tool = options.paintTool();
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
    const tool = options.paintTool();
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
        if (points.length > 0) options.onStrokeCommit(points);
        return;
      }
      case 'flatten': {
        if (pointerDownButton !== 0 || event.button !== 0) return;
        const travelled = Math.hypot(event.clientX - pointerDownX, event.clientY - pointerDownY);
        if (travelled > CLICK_TOLERANCE_PX) return;
        const hit = raycastPaintHit(ctx, event);
        if (!hit) return;
        options.onFlattenCommit(
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
   * Abandons the paint stroke in progress WITHOUT committing it: the sampled
   * points and their ghost preview meshes are discarded and the orbit camera is
   * handed back. The one place a stroke is torn down without emitting it, so the
   * recovery paths cannot drift from each other. It runs both when a
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

  /**
   * The paint keyboard shortcuts: Tab held toggles the consumer's hide state,
   * "?" toggles the shortcut help popover, Ctrl+Z (or Cmd+Z) undoes and Ctrl+Y
   * (or Cmd+Y, or Cmd+Shift+Z on mac) redoes, B/E/S pick the paint tools, V or
   * Escape returns to pointer mode, and [ and ] step the brush radius. None of
   * these fire while focus sits in a field.
   */
  function onKeyDownGlobal(event: KeyboardEvent): void {
    if (event.key === 'Tab') {
      if (isEditableTarget(event.target)) return;
      if (!event.repeat) {
        tabHeld.value = true;
        options.onTabHeldChange?.();
      }
      event.preventDefault();
      return;
    }
    if (isEditableTarget(event.target)) return;
    if (event.key === '?') {
      options.onToggleShortcutHelp();
      event.preventDefault();
      return;
    }
    const key = event.key;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && (key === 'z' || key === 'Z') && !event.shiftKey) {
      if (options.canUndo()) {
        options.onUndo();
        event.preventDefault();
      }
      return;
    }
    if (modifier && ((key === 'y' || key === 'Y') || (event.shiftKey && (key === 'z' || key === 'Z')))) {
      if (options.canRedo()) {
        options.onRedo();
        event.preventDefault();
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (key) {
      case 'b':
      case 'B':
        options.onSetTool('add');
        break;
      case 'e':
      case 'E':
        options.onSetTool('remove');
        break;
      case 's':
      case 'S':
        options.onSetTool('flatten');
        break;
      case 'v':
      case 'V':
      case 'Escape':
        if (options.paintTool() === null) return;
        options.onSetTool(null);
        break;
      case '[':
        options.onStepBrushRadius(-BRUSH_RADIUS_STEP_MM);
        break;
      case ']':
        options.onStepBrushRadius(BRUSH_RADIUS_STEP_MM);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  /** Tab release clears the held state and lets the consumer restore its hidden layers. */
  function onKeyUpGlobal(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    tabHeld.value = false;
    options.onTabHeldChange?.();
    if (!isEditableTarget(event.target)) event.preventDefault();
  }

  /**
   * Losing the window (Alt+Tab, a click into another app) never delivers the Tab
   * keyup, so the held state is cleared here instead, exactly as the keyup would.
   */
  function onWindowBlurGlobal(): void {
    if (!tabHeld.value) return;
    tabHeld.value = false;
    options.onTabHeldChange?.();
  }

  function setup(ctx: ThreeSceneContext): void {
    onPointerDownHandler = (event: PointerEvent) => {
      pointerDownX = event.clientX;
      pointerDownY = event.clientY;
      pointerDownButton = event.button;
      onPointerDownPaint(ctx, event);
    };
    onPointerMoveHandler = (event: PointerEvent) => onPointerMovePaint(ctx, event);
    onPointerUpHandler = (event: PointerEvent) => onPointerUpPaint(ctx, event);
    onKeyDown = (event: KeyboardEvent) => onKeyDownGlobal(event);
    onKeyUp = (event: KeyboardEvent) => onKeyUpGlobal(event);
    onWindowBlur = () => onWindowBlurGlobal();
    ctx.canvas.addEventListener('pointerdown', onPointerDownHandler);
    ctx.canvas.addEventListener('pointermove', onPointerMoveHandler);
    ctx.canvas.addEventListener('pointerup', onPointerUpHandler);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);
    ctx.modelRoot.add(paintCursorMesh);
    ctx.modelRoot.add(paintFlattenCylinderMesh);
  }

  function teardown(ctx: ThreeSceneContext): void {
    if (onPointerDownHandler) ctx.canvas.removeEventListener('pointerdown', onPointerDownHandler);
    if (onPointerMoveHandler) ctx.canvas.removeEventListener('pointermove', onPointerMoveHandler);
    if (onPointerUpHandler) ctx.canvas.removeEventListener('pointerup', onPointerUpHandler);
    if (onKeyDown) window.removeEventListener('keydown', onKeyDown);
    if (onKeyUp) window.removeEventListener('keyup', onKeyUp);
    if (onWindowBlur) window.removeEventListener('blur', onWindowBlur);
    onPointerDownHandler = null;
    onPointerMoveHandler = null;
    onPointerUpHandler = null;
    onKeyDown = null;
    onKeyUp = null;
    onWindowBlur = null;

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
  }

  return {
    setup,
    teardown,
    abortStroke,
    hidePaintCursor,
    pointerDownState: () => ({ button: pointerDownButton, x: pointerDownX, y: pointerDownY }),
    tabHeld: () => tabHeld.value,
  };
}
