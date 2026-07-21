import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { MeshData } from '../engine/gridfinity/types';
import type { MeshBounds } from '../engine/cutout/cutoutMesh';
import type { ModelPlacement } from '../engine/cutout/cutoutBin';
import { ERROR, INFO, PRIMARY } from '../themeColors';
import type { CutoutGhost, CutoutGhostMoved } from '../components/cutout/cutoutGhost';
import { buildMeshObject, createGhostMaterial, type ThreeSceneContext } from './useThreeScene';

/**
 * The cutout editor's placed models: the translucent ghosts drawn for each one
 * and the gizmo that moves and turns the selected one. Layered onto the base
 * viewport, which owns the scene, so this holds only the model geometry, the
 * two TransformControls instances and the selection and colour bookkeeping.
 *
 * The ghosts are the imported triangles drawn directly and transformed on the
 * main thread, so a drag runs at frame rate with no CSG at all; the real carve
 * is what the tab starts once the drag ends.
 *
 * It is imperative rather than reactive: the component that mounts it wires the
 * watchers and pointer listeners exactly as before and calls these methods, so
 * the event ordering that keeps a drag, a paint stroke and the orbit camera from
 * fighting stays visible at the one place that arbitrates them.
 */

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
 * click on a trackpad still does. Shared with the flatten tool's click test,
 * which draws the same line between a click and a camera drag.
 */
export const CLICK_TOLERANCE_PX = 4;

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

/** The pointer-press position a select-on-release test measures its travel against. */
export interface PointerDownState {
  button: number;
  x: number;
  y: number;
}

/** The reactive state the gizmo reads, and the events it raises back to the tab. */
export interface ModelGizmoOptions {
  /** The placed models, in list order. */
  ghosts: () => CutoutGhost[];
  /** Which model the gizmo is attached to, or null for no selection. */
  selectedModelId: () => string | null;
  /** Ids of the models the last carve warned about, painted red. */
  warnedModelIds: () => readonly string[];
  /** True while a paint tool owns the pointer, so the gizmo lets go. */
  paintActive: () => boolean;
  /** True while the model ghosts are hidden (Tab held or the eye button). */
  modelsHidden: () => boolean;
  /** A ghost was clicked, or empty space was clicked to clear the selection. */
  onSelect: (id: string | null) => void;
  /** The selected model moved. Fires continuously through a drag, and carves nothing. */
  onPlacementChange: (moved: CutoutGhostMoved) => void;
  /** The drag ended. This is the event a fresh carve should start from. */
  onPlacementCommit: (moved: CutoutGhostMoved) => void;
  /** A ghost's exact bounds were recomputed after it was drawn or moved. */
  onBoundsChange: (moved: CutoutGhostMoved) => void;
}

/** The imperative surface the cutout viewport drives. */
export interface ModelGizmo {
  /** Create the two TransformControls and wire the orbit arbitration. Call from onReady. */
  setup(ctx: ThreeSceneContext): void;
  /** Detach and dispose the gizmo, the ghosts and their materials. Call from onTeardown. */
  teardown(ctx: ThreeSceneContext): void;
  /** Reconcile the drawn ghosts with the model list, then repaint and reattach the gizmo. */
  syncGhosts(ctx: ThreeSceneContext): void;
  /** Reconcile the gizmo attachment with the selection, the paint tool and the ghosts. */
  syncGizmo(): void;
  /** Give every drawn ghost the material its current tone calls for. */
  paintGhosts(): void;
  /** Apply the current hidden state to every drawn ghost mesh. */
  applyGhostVisibility(): void;
  /** A pointer release: select the ghost under it, or clear the selection. */
  selectAtPointer(ctx: ThreeSceneContext, event: PointerEvent, down: PointerDownState): void;
  /** Force any stuck drag released, the gizmo half of an interrupted-pointer recovery. */
  releaseStuckDrag(): void;
}

export function useModelGizmo(options: ModelGizmoOptions): ModelGizmo {
  /**
   * The three ghost materials, one per tone, taking their colours from the
   * theme's own accents: the amber the app accents everything with, the info
   * blue and the error red.
   *
   * Keyed by the tone rather than switched on it. A record over the union is
   * total by construction: a tone added later is a compile error here, at the
   * definition, rather than a case that falls through at run time.
   */
  const ghostMaterials: Record<GhostTone, THREE.MeshStandardMaterial> = {
    plain: createGhostMaterial(PRIMARY),
    selected: createGhostMaterial(INFO),
    warned: createGhostMaterial(ERROR),
  };

  const ghostEntries = new Map<string, GhostEntry>();

  let translateControls: TransformControls | null = null;
  let rotateControls: TransformControls | null = null;
  let attachedId: string | null = null;
  let draggingId: string | null = null;

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
   * the eight corners of the untransformed box is cheaper but overestimates
   * every shape that is not itself a box, so the footprint the readout shows
   * would be wrong and the bin the fit button sizes would come out larger than
   * the models need.
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
    if (options.warnedModelIds().includes(id)) return 'warned';
    if (id === options.selectedModelId()) return 'selected';
    return 'plain';
  }

  /**
   * Give every drawn ghost the material its current tone calls for.
   *
   * Runs over the whole map rather than at the point something changes, and
   * that is the point: the tone is a pure function of the props, so a ghost
   * cannot be left holding a material chosen for a state that has since passed.
   * Selecting a second model repaints the one that lost the selection as well
   * as the one that gained it, whichever way the selection was changed, and
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

  /**
   * Applies the current hidden state to every drawn ghost mesh. Called after
   * every ghost sync (so a ghost rebuilt while hidden comes in hidden), and
   * whenever the caller's hidden state changes. Selection and warning colours
   * are untouched: only visibility changes.
   */
  function applyGhostVisibility(): void {
    const hidden = options.modelsHidden();
    for (const entry of ghostEntries.values()) {
      entry.mesh.visible = !hidden;
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

  function syncGhosts(ctx: ThreeSceneContext): void {
    const ghosts = options.ghosts();
    const wanted = new Set(ghosts.map((ghost) => ghost.id));
    for (const [id, entry] of ghostEntries) {
      if (wanted.has(id)) continue;
      disposeGhost(ctx, entry);
      ghostEntries.delete(id);
    }
    for (const ghost of ghosts) {
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
        options.onBoundsChange({
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
      options.onBoundsChange({
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
   * The single source of gizmo attachment. Desired attachment is a pure
   * function of the selection, the paint tool and the drawn ghosts; this
   * reconciles the live controls to it and is safe to call after any change
   * that can affect it.
   */
  function syncGizmo(): void {
    if (!translateControls || !rotateControls) return;
    const enabled = !options.paintActive();
    translateControls.enabled = enabled;
    rotateControls.enabled = enabled;
    const selectedId = options.selectedModelId();
    const desiredMesh =
      enabled && selectedId !== null ? (ghostEntries.get(selectedId)?.mesh ?? null) : null;
    if ((translateControls.object ?? null) === desiredMesh) return;
    if (desiredMesh === null) {
      translateControls.detach();
      rotateControls.detach();
      attachedId = null;
    } else {
      translateControls.attach(desiredMesh);
      rotateControls.attach(desiredMesh);
      attachedId = selectedId;
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

  function selectAtPointer(
    ctx: ThreeSceneContext,
    event: PointerEvent,
    down: PointerDownState,
  ): void {
    if (options.paintActive()) return;
    if (down.button !== 0 || event.button !== 0) return;
    const travelled = Math.hypot(event.clientX - down.x, event.clientY - down.y);
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
    options.onSelect(hits.length === 0 ? null : entryIdOf(hits[0].object));
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
      if (moved) options.onPlacementCommit(moved);
    });
    instance.addEventListener('objectChange', () => {
      if (draggingId === null) return;
      const moved = movedPayload(draggingId);
      if (moved) options.onPlacementChange(moved);
    });
  }

  function setup(ctx: ThreeSceneContext): void {
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
  }

  function teardown(ctx: ThreeSceneContext): void {
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
    for (const material of Object.values(ghostMaterials)) material.dispose();
  }

  return {
    setup,
    teardown,
    syncGhosts,
    syncGizmo,
    paintGhosts,
    applyGhostVisibility,
    selectAtPointer,
    releaseStuckDrag,
  };
}
