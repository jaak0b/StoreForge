import type { MeshData } from '../../engine/gridfinity/types';
import type { ModelPlacement } from '../../engine/cutout/cutoutBin';
import type { MeshBounds } from '../../engine/cutout/cutoutMesh';

/**
 * What the cutout editor's viewport draws for one placed model, and what it
 * reports back when the gizmo moves one.
 *
 * These sit beside the component rather than inside it because the tab that
 * owns the models has to build the one and read the other, and a type declared
 * inside a script setup block cannot be exported.
 */

/** One placed model as the viewport draws it. */
export interface CutoutGhost {
  /** The model's id within the bin, echoed back in every event. */
  id: string;
  /**
   * The model's triangles in its own centred millimetre frame, which is the
   * frame the worker's cached cutter solid uses, so the ghost and the carved
   * pocket agree.
   *
   * Compared by object identity: hand back the same object while only the
   * placement changes and the geometry is reused rather than rebuilt, which is
   * what keeps dragging a large model from re-uploading it every frame.
   */
  mesh: MeshData;
  /** Where the model currently sits, in bin-local millimetres and degrees. */
  placement: ModelPlacement;
}

/**
 * Where a dragged model ended up. The bounds travel with the placement because
 * they are exact transformed bounds that only the viewport holds the geometry
 * to compute, and recomputing them anywhere else would mean keeping a second
 * copy of the triangles.
 */
export interface CutoutGhostMoved {
  id: string;
  placement: ModelPlacement;
  /** Exact bounds of the transformed model in bin-local mm, without clearance. */
  bounds: MeshBounds;
}
