import * as THREE from 'three';
import type { MeshData } from '../engine/gridfinity/types';
import {
  buildMeshObject,
  createBodyMaterial,
  createLabelMaterial,
  type ThreeSceneContext,
} from './useThreeScene';

/**
 * The bin body and its label, the two-mesh preview every 3D viewport in the app
 * draws. It owns the two materials and the two meshes, rebuilds them when the
 * geometry changes, and disposes them on teardown. A viewport that only shows a
 * bin uses nothing else; the cutout editor layers its ghosts and gizmo on top of
 * this same base.
 *
 * The body mesh is exposed because the cavity paint tools raycast against the
 * carved surface, and this is the one place that surface is drawn: no consumer
 * keeps a second reference to it.
 */
export interface BinMeshDisplay {
  /**
   * Draw the given body and label, replacing whatever was drawn before. A no-op
   * when both meshes are the same objects already drawn, so a viewport can call
   * it on every reactive change without rebuilding geometry that did not move.
   */
  sync(ctx: ThreeSceneContext, body: MeshData | null, label: MeshData | null): void;
  /** Dispose both meshes and both materials. Call from the scene's teardown. */
  dispose(ctx: ThreeSceneContext): void;
  /** The current body mesh, for a consumer that raycasts against the drawn surface. */
  readonly bodyMesh: THREE.Mesh | null;
}

export function useBinMesh(): BinMeshDisplay {
  const bodyMaterial = createBodyMaterial();
  const labelMaterial = createLabelMaterial();

  let bodyMesh: THREE.Mesh | null = null;
  let labelMesh: THREE.Mesh | null = null;
  let drawnBody: MeshData | null = null;
  let drawnLabel: MeshData | null = null;

  function clear(ctx: ThreeSceneContext): void {
    if (bodyMesh) {
      ctx.modelRoot.remove(bodyMesh);
      bodyMesh.geometry.dispose();
      bodyMesh = null;
    }
    if (labelMesh) {
      ctx.modelRoot.remove(labelMesh);
      labelMesh.geometry.dispose();
      labelMesh = null;
    }
  }

  function sync(ctx: ThreeSceneContext, body: MeshData | null, label: MeshData | null): void {
    if (body === drawnBody && label === drawnLabel) return;
    drawnBody = body;
    drawnLabel = label;
    clear(ctx);
    if (!body) return;
    bodyMesh = buildMeshObject(body, bodyMaterial);
    ctx.modelRoot.add(bodyMesh);
    if (label) {
      labelMesh = buildMeshObject(label, labelMaterial);
      ctx.modelRoot.add(labelMesh);
    }
  }

  function dispose(ctx: ThreeSceneContext): void {
    clear(ctx);
    bodyMaterial.dispose();
    labelMaterial.dispose();
  }

  return {
    sync,
    dispose,
    get bodyMesh(): THREE.Mesh | null {
      return bodyMesh;
    },
  };
}
