// The carve stage shared by every bin whose interior is filled solid and then
// cut away again: build the standard slotted bin, fill its interior cavity
// from the floor top to the nominal bin top, subtract a set of cutter solids,
// and restore the label slot the fill closed. The traced pocket bin and the
// cutout bin differ only in how they build their cutters, so everything either
// side of that step lives here. Framework-agnostic; the ManifoldToplevel is
// injected as everywhere else in the engine.
import type {
  CrossSection,
  ExecutionContext,
  Manifold,
  ManifoldToplevel,
} from 'manifold-3d';
import {
  binInteriorSizeMm,
  binOuterSizeMm,
  FLOOR_TOP,
  HEIGHT_UNIT,
  OUTER_CORNER_RADIUS,
  WALL_THICKNESS,
} from './constants';
import { buildSlottedBinBody, hasFusedShelf, roundedRectPolygon } from './binGenerator';
import { applySlotToBody, FUSED_SHELF_REACH_DEPTH, SLOT_REACH_DEPTH } from '../label/slot';
import type { BinParams, SlottedBinParams } from './types';

/** The bin parameters every carve flow shares: a slotted bin body's parameters. */
export type CarvedBinParams = BinParams & { labelSlot?: boolean } & Pick<
    SlottedBinParams,
    'fusedLabel'
  >;

/**
 * Overlap used to avoid coincident-face gaps in the CSG union and subtraction
 * of a carve. It only extends cuts past free surfaces or fill into material it
 * unions with; it never alters a finished dimension, since the extra 0.01 mm is
 * always consumed inside a face that gets cut away or welded over. The single
 * home for the figure; cutter builders that must reach past a free surface take
 * it from here.
 */
export const CARVE_OVERLAP_EPS = 0.01;

/**
 * Thrown when an ExecutionContext attached to a carve cancelled it before it
 * finished. Not a failure, and never shown to the user: the only thing that
 * cancels a carve is a newer request from the same caller, which produces the
 * result the user actually waits for.
 *
 * It carries its own class so a caller can tell supersession apart from the
 * generic invalid-solid failure. Without it a superseded carve would reach the
 * user as `... produced an invalid solid: Cancelled`, which reads as a defect
 * in a bin that is perfectly fine.
 *
 * Manifold documents cancellation as permanent for a Manifold, so a cancelled
 * solid is deleted where it is detected and never inspected further.
 */
export class CarveCancelledError extends Error {
  constructor(subject: string) {
    super(`${subject} generation was superseded by a newer request and was cancelled.`);
    this.name = 'CarveCancelledError';
  }
}

/**
 * Cross-section of the bin's interior cavity: the same inset rounded rectangle
 * the bin generator cuts the cavity with. The single home for this profile;
 * every carve flow takes it from here.
 */
export function interiorSection(
  m: ManifoldToplevel,
  gridX: number,
  gridY: number,
): CrossSection {
  return new m.CrossSection(
    [
      roundedRectPolygon(
        binInteriorSizeMm(gridX),
        binInteriorSizeMm(gridY),
        OUTER_CORNER_RADIUS - WALL_THICKNESS,
      ),
    ],
    'NonZero',
  );
}

/**
 * The interior fill solid: the interior cavity from the floor top up to the
 * nominal bin top, reaching CARVE_OVERLAP_EPS into the floor plate so it welds
 * to it. Exported so tests can measure the fill independently of any carve.
 */
export function buildInteriorFill(m: ManifoldToplevel, params: BinParams): Manifold {
  const bodyTop = params.heightUnits * HEIGHT_UNIT;
  const section = interiorSection(m, params.gridX, params.gridY);
  const fill = section
    .extrude(bodyTop - FLOOR_TOP + CARVE_OVERLAP_EPS)
    .translate(0, 0, FLOOR_TOP - CARVE_OVERLAP_EPS);
  section.delete();
  return fill;
}

/**
 * The deepest a cut may reach before it breaks through the interior floor:
 * from the nominal bin top down to the top of the floor plate. The single home
 * for this figure; the depth validation messages quote it.
 */
export function maxCarveDepthMm(heightUnits: number): number {
  return heightUnits * HEIGHT_UNIT - FLOOR_TOP;
}

/**
 * The plan strip the label insert slot or the fused label shelf occupies, or
 * null when the bin has neither. Any carve overlapping it would undercut the
 * seat the insert rests on: the slot floor must stay whole for the insert to
 * rest on, and the shelf's plate chamfer and the support ribs under it must
 * stay solid. Carves are cut from the bin top down, and SLOT_REACH_DEPTH is the
 * structure's widest plan extent at every depth. A fused label stands on the
 * same shelf at its own plan reach and needs it whole for the same reason,
 * blank label or not, because the shelf occupies that strip either way.
 *
 * The caller owns the returned section and words its own message around the
 * name, because the message names the thing that offended.
 */
export function labelStructureStrip(
  m: ManifoldToplevel,
  params: CarvedBinParams,
): { section: CrossSection; name: string } | null {
  const fused = hasFusedShelf(params);
  if (!fused && params.labelSlot === false) return null;
  const outerWidth = binOuterSizeMm(params.gridX);
  const outerDepth = binOuterSizeMm(params.gridY);
  const stripDepth = fused ? FUSED_SHELF_REACH_DEPTH : SLOT_REACH_DEPTH;
  return {
    section: new m.CrossSection(
      [
        [
          [-outerWidth / 2, -outerDepth / 2],
          [outerWidth / 2, -outerDepth / 2],
          [outerWidth / 2, -outerDepth / 2 + stripDepth],
          [-outerWidth / 2, -outerDepth / 2 + stripDepth],
        ],
      ],
      'NonZero',
    ),
    name: fused ? 'fused label shelf' : 'label insert slot',
  };
}

/**
 * Build a bin whose interior is filled solid and then carved by the given
 * cutter solids. The standard slotted bin body is built first with the scoop
 * suppressed (the interior is filled solid, so a scoop has nothing to sweep and
 * would only fight the carve), its interior cavity is filled from the floor top
 * up to the nominal bin top so the cuts have material to sink into, and the
 * cutters are subtracted. The interior fill closes the insert channel, so the
 * slot is applied again last; a bin without the slot has no channel to restore.
 *
 * The caller owns validating its own cutters; this stage owns the fill, the
 * subtraction, restoring the slot the fill closed, and the manifold status
 * check. `subject` names the flow in the invalid-solid message, for example
 * 'Pocket bin'.
 *
 * `ctx` makes the carve observable and cancellable by the caller that started
 * it. Where it attaches is not a free choice. Booleans are deferred in
 * manifold, so the subtraction is not computed when it is written but when
 * something first asks about the result, and an ExecutionContext is consumed
 * by that one eager operation. Restoring the label slot asks first, on a bin
 * that has a slot, so attaching after that point would attach to a tree with
 * no work left in it and a cancellation would observe nothing. The context is
 * therefore attached to the subtraction and evaluated immediately, which is
 * also where the time actually goes. A caller that never supersedes its own
 * requests, such as an export, passes nothing and the carve stays lazy exactly
 * as it was before.
 *
 * Takes ownership of `cutters`: every element is deleted before returning, on
 * the success and the failure path alike.
 */
export function buildCarvedBinBody(
  m: ManifoldToplevel,
  params: CarvedBinParams,
  cutters: Manifold[],
  subject: string,
  ctx?: ExecutionContext,
): Manifold {
  try {
    const shelved = buildSlottedBinBody(m, { ...params, scoop: false });
    const fill = buildInteriorFill(m, params);
    const filled = m.Manifold.union([shelved, fill]);
    shelved.delete();
    fill.delete();

    let body: Manifold;
    if (cutters.length > 0) {
      const cutter = m.Manifold.union(cutters);
      body = m.Manifold.difference(filled, cutter);
      filled.delete();
      cutter.delete();
    } else {
      body = filled;
    }
    if (ctx !== undefined) {
      // withContext returns a copy carrying the attachment, which the status
      // check on the next line consumes by evaluating the subtraction.
      const observed = body.withContext(ctx);
      body.delete();
      body = observed;
      if (body.status() === 'Cancelled') {
        // Cancellation is permanent for a Manifold, so the solid is released
        // here and never inspected further.
        body.delete();
        throw new CarveCancelledError(subject);
      }
    }
    if (params.labelSlot !== false) {
      body = applySlotToBody(m, params, body);
    }
    const status = body.status();
    if (status === 'Cancelled') {
      body.delete();
      throw new CarveCancelledError(subject);
    }
    if (status !== 'NoError') {
      body.delete();
      throw new Error(`${subject} generation produced an invalid solid: ${status}`);
    }
    return body;
  } finally {
    for (const cutter of cutters) cutter.delete();
  }
}
