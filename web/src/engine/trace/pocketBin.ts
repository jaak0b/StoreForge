// Gridfinity bins with tool-shaped pockets, in the style of a tool-trace
// (shadow board) insert. Builds on the standard bin generator: the bin is
// generated as usual, its interior cavity is filled solid from the floor top
// to the nominal bin top, and each placed tool's resolved outline is then
// subtracted from the bin top down to its pocket depth, with vertical
// finger-hole reliefs so the tool can be lifted out. Framework-agnostic; the
// ManifoldToplevel and Font are injected as everywhere else in the engine.
import type { CrossSection, Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import type { Font } from 'opentype.js';
import type { FingerHole, MmPoint, TracedOutline, TracedTool, ToolPlacement } from './types';
import { fingerHoleOutline, resolvedToolOutline } from './edit';
import {
  binInteriorSizeMm,
  binOuterSizeMm,
  FLOOR_TOP,
  HEIGHT_UNIT,
  LIP_HEIGHT,
  OUTER_CORNER_RADIUS,
  WALL_THICKNESS,
} from '../gridfinity/constants';
import {
  buildInsertInSlotSolids,
  buildSlottedBinBody,
  hasFusedLabel,
  labelSpecOf,
  manifoldToMeshData,
  roundedRectPolygon,
} from '../gridfinity/binGenerator';
import {
  applySlotToBody,
  buildFusedLabel,
  FUSED_SHELF_REACH_DEPTH,
  SLOT_REACH_DEPTH,
} from '../label/slot';
import type { BinParams, MeshData, PartMeshes, SlottedBinParams } from '../gridfinity/types';

/** A slotted bin plus the tools whose pockets are sunk into its interior. */
export interface PocketBinParams extends SlottedBinParams {
  tools: TracedTool[];
  placements: ToolPlacement[];
}

/** A tool resolved and moved into bin-local mm, ready to cut as a pocket. */
export interface PlacedPocket {
  tool: TracedTool;
  /** The tool's resolved outline, translated into bin-local mm. */
  outline: TracedOutline;
  /** The tool's finger holes, translated into bin-local mm. */
  fingerHoles: FingerHole[];
  pocketDepthMm: number;
}

/**
 * Resolve each placement against its tool and translate the resolved outline
 * and finger holes into bin-local mm (bin centred on the origin). A placement
 * naming a missing tool is a user-fixable plan problem and errors with a
 * user-worded message.
 */
export function placeTools(
  m: ManifoldToplevel,
  tools: TracedTool[],
  placements: ToolPlacement[],
): PlacedPocket[] {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  return placements.map((placement) => {
    const tool = byId.get(placement.toolId);
    if (!tool) {
      throw new Error(
        'A pocket refers to a tool that is no longer in the plan. Remove that pocket and place the tool again.',
      );
    }
    const resolved = resolvedToolOutline(m, tool);
    const move = (p: MmPoint): MmPoint => ({
      x: p.x + placement.xMm,
      y: p.y + placement.yMm,
    });
    return {
      tool,
      outline: {
        outer: resolved.outer.map(move),
        holes: resolved.holes.map((loop) => loop.map(move)),
      },
      fingerHoles: tool.fingerHoles.map((hole) => ({
        ...hole,
        x: hole.x + placement.xMm,
        y: hole.y + placement.yMm,
        ...(hole.x2 !== undefined && hole.y2 !== undefined
          ? { x2: hole.x2 + placement.xMm, y2: hole.y2 + placement.yMm }
          : {}),
      })),
      pocketDepthMm: placement.pocketDepthMm,
    };
  });
}

/** Cross-section of an outline (outer plus holes, EvenOdd per the outline convention). */
function outlineSection(m: ManifoldToplevel, outline: TracedOutline): CrossSection {
  const loops: SimplePolygon[] = [outline.outer, ...outline.holes].map((loop) =>
    loop.map((p) => [p.x, p.y] as [number, number]),
  );
  return new m.CrossSection(loops, 'EvenOdd');
}

/**
 * Cross-section of everything a placed tool cuts from the bin: its pocket
 * outline plus its finger-hole circles. Used for the wall-clearance check, so
 * a finger hole poking into the wall is caught like the outline itself.
 */
function placedCutSection(m: ManifoldToplevel, placed: PlacedPocket): CrossSection {
  let section = outlineSection(m, placed.outline);
  for (const hole of placed.fingerHoles) {
    const circle = outlineSection(m, fingerHoleOutline(hole));
    const merged = section.add(circle);
    section.delete();
    circle.delete();
    section = merged;
  }
  return section;
}

/**
 * Cross-section of the bin's interior cavity: the same inset rounded
 * rectangle the bin generator cuts the cavity with.
 */
function interiorSection(m: ManifoldToplevel, gridX: number, gridY: number): CrossSection {
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
 * The deepest pocket a bin of the given height allows: from the nominal bin
 * top down to the top of the interior floor. The single home for this figure;
 * the depth validation message quotes it.
 */
export function maxPocketDepthMm(heightUnits: number): number {
  return heightUnits * HEIGHT_UNIT - FLOOR_TOP;
}

/** True when the two cross-sections share any area. */
function sectionsOverlap(a: CrossSection, b: CrossSection): boolean {
  const overlap = a.intersect(b);
  const result = !overlap.isEmpty();
  overlap.delete();
  return result;
}

/**
 * Validate a pocket layout against the bin parameters: pockets cannot share a
 * bin with divider walls, every pocket depth must stay above the interior
 * floor, every pocket (outline and finger holes) must stay inside the
 * interior cavity, and pockets must not overlap each other. All violations
 * are user-fixable and error with user-worded messages.
 */
export function validatePocketLayout(
  m: ManifoldToplevel,
  params: BinParams & { labelSlot?: boolean } & Pick<SlottedBinParams, 'fusedLabel'>,
  placed: PlacedPocket[],
): void {
  if (params.dividerCountX > 0 || params.dividerCountY > 0) {
    throw new Error(
      'Tool pockets cannot be combined with divider walls. Remove the dividers to add pockets.',
    );
  }
  const maxDepth = maxPocketDepthMm(params.heightUnits);
  for (const pocket of placed) {
    if (!(pocket.pocketDepthMm > 0)) {
      throw new Error(`The pocket for "${pocket.tool.name}" needs a depth greater than 0 mm.`);
    }
    if (pocket.pocketDepthMm > maxDepth) {
      throw new Error(
        `The pocket for "${pocket.tool.name}" is ${pocket.pocketDepthMm} mm deep, but a bin ` +
          `${params.heightUnits} units tall allows at most ${maxDepth} mm before the pocket ` +
          'would break through the interior floor. Make the pocket shallower or the bin taller.',
      );
    }
  }
  const interior = interiorSection(m, params.gridX, params.gridY);
  const cutSections = placed.map((pocket) => placedCutSection(m, pocket));
  // The insert seat and its support structure cannot be cut into (the slot
  // floor must stay whole for the insert to rest on, and the shelf's plate
  // chamfer and support ribs under it must stay solid), so pockets must stay
  // clear of the slot structure's full plan reach: pockets are cut from the
  // bin top down, and SLOT_REACH_DEPTH is the structure's widest plan extent
  // at every depth. A fused label stands on the same shelf at its own plan
  // reach and needs it whole for the same reason. A bin with neither has no
  // such region to protect.
  const fused = hasFusedLabel(params);
  const structureName = fused ? 'fused label shelf' : 'label insert slot';
  let slotStrip: CrossSection | null = null;
  if (fused || params.labelSlot !== false) {
    const outerWidth = binOuterSizeMm(params.gridX);
    const outerDepth = binOuterSizeMm(params.gridY);
    const stripDepth = fused ? FUSED_SHELF_REACH_DEPTH : SLOT_REACH_DEPTH;
    slotStrip = new m.CrossSection(
      [
        [
          [-outerWidth / 2, -outerDepth / 2],
          [outerWidth / 2, -outerDepth / 2],
          [outerWidth / 2, -outerDepth / 2 + stripDepth],
          [-outerWidth / 2, -outerDepth / 2 + stripDepth],
        ],
      ],
      'NonZero',
    );
  }
  try {
    for (let i = 0; i < placed.length; i += 1) {
      const outside = cutSections[i].subtract(interior);
      const pokesOut = !outside.isEmpty();
      outside.delete();
      if (pokesOut) {
        throw new Error(
          `The pocket for "${placed[i].tool.name}" reaches into the bin wall. ` +
            'Move it away from the walls or use a larger bin.',
        );
      }
      if (slotStrip !== null && sectionsOverlap(cutSections[i], slotStrip)) {
        throw new Error(
          `The pocket for "${placed[i].tool.name}" reaches under the ${structureName}. ` +
            'Move it away from the front wall or use a deeper bin.',
        );
      }
    }
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = outlineSection(m, placed[i].outline);
        const b = outlineSection(m, placed[j].outline);
        const overlapping = sectionsOverlap(a, b);
        a.delete();
        b.delete();
        if (overlapping) {
          throw new Error(
            `The pockets for "${placed[i].tool.name}" and "${placed[j].tool.name}" overlap. ` +
              'Move them apart.',
          );
        }
      }
    }
  } finally {
    interior.delete();
    slotStrip?.delete();
    for (const section of cutSections) section.delete();
  }
}

/**
 * Build the pocket-bin body as a manifold. The standard slotted bin body is
 * built first, its interior cavity is filled solid from the floor top up to
 * the nominal bin top so the pockets have material to sink into, and the
 * pockets are subtracted. Each pocket is cut from above the bin top down to
 * bodyTop minus its depth; finger holes are cut further, down to the top of
 * the interior floor. They are grab reliefs, not through-holes: the floor
 * plate under them stays intact. The interior fill closes the insert
 * channel, so the slot is applied again last.
 */
export function buildPocketBinBody(m: ManifoldToplevel, params: PocketBinParams): Manifold {
  const placed = placeTools(m, params.tools, params.placements);
  validatePocketLayout(m, params, placed);

  const bodyTop = params.heightUnits * HEIGHT_UNIT;
  const solidTop = bodyTop + LIP_HEIGHT;
  // Overlap used to avoid coincident-face gaps in the CSG union/subtraction
  // below. It only extends cuts past free surfaces or fill into material it
  // unions with; it never alters a finished dimension, since the extra 0.01
  // mm is always consumed inside a face that gets cut away or welded over.
  const eps = 0.01;

  const cutters: Manifold[] = [];
  for (const pocket of placed) {
    const pocketBottom = bodyTop - pocket.pocketDepthMm;
    const section = outlineSection(m, pocket.outline);
    cutters.push(
      section.extrude(solidTop + eps - pocketBottom).translate(0, 0, pocketBottom),
    );
    section.delete();
    for (const hole of pocket.fingerHoles) {
      const circle = outlineSection(m, fingerHoleOutline(hole));
      cutters.push(circle.extrude(solidTop + eps - FLOOR_TOP).translate(0, 0, FLOOR_TOP));
      circle.delete();
    }
  }

  // Pocket bins skip the scoop: the interior is filled solid for the tool
  // pockets, so a scoop would fight the pocket layout, and the reference
  // scoop is a loose-parts feature, not a shadow-board one.
  const shelved = buildSlottedBinBody(m, { ...params, scoop: false });
  // Fill the interior cavity solid between the floor top and the bin top,
  // reaching eps into the floor plate so the fill welds to it.
  const fillSection = interiorSection(m, params.gridX, params.gridY);
  const fill = fillSection
    .extrude(bodyTop - FLOOR_TOP + eps)
    .translate(0, 0, FLOOR_TOP - eps);
  fillSection.delete();
  const filled = m.Manifold.union([shelved, fill]);
  shelved.delete();
  fill.delete();
  let body: Manifold;
  if (cutters.length > 0) {
    const cutter = m.Manifold.union(cutters);
    for (const c of cutters) c.delete();
    body = m.Manifold.difference(filled, cutter);
    filled.delete();
    cutter.delete();
  } else {
    body = filled;
  }
  // The interior fill closed the insert channel; apply the slot again. A
  // bin without the slot has no channel to restore.
  if (params.labelSlot !== false) {
    body = applySlotToBody(m, params, body);
  }
  const status = body.status();
  if (status !== 'NoError') {
    body.delete();
    throw new Error(`Pocket bin generation produced an invalid solid: ${status}`);
  }
  return body;
}

/**
 * Generate a pocket bin as separate body and (when the parameters carry the
 * paired insert's content) preview-insert meshes, mirroring
 * generateSlottedBin so the insert keeps its own color.
 */
export function generatePocketBin(
  m: ManifoldToplevel,
  font: Font,
  params: PocketBinParams,
): PartMeshes {
  let body = buildPocketBinBody(m, params);
  let label: Manifold | null = null;
  try {
    if (params.fusedLabel != null) {
      // Fused: the pocket bin body carries no slot, and the label is raised on
      // the top face as the second-filament mesh.
      label = buildFusedLabel(m, font, labelSpecOf(params.fusedLabel), params);
    } else if (params.insert !== null) {
      // Like generateSlottedBin: the insert's plate joins the body mesh and
      // only its raised label face keeps the label color.
      const placed = buildInsertInSlotSolids(m, font, params.insert, params);
      const withPlate = m.Manifold.union([body, placed.plate]);
      body.delete();
      placed.plate.delete();
      body = withPlate;
      label = placed.label;
    }
    return {
      body: manifoldToMeshData(body),
      label: label ? manifoldToMeshData(label) : null,
    };
  } finally {
    body.delete();
    label?.delete();
  }
}

/**
 * Generate a pocket bin as one unioned mesh for the single-mesh STL download.
 * A paired insert never rides along (it is its own part), but a fused label is
 * part of the bin, so it is unioned into the single mesh.
 */
export function generatePocketBinUnion(
  m: ManifoldToplevel,
  font: Font,
  params: PocketBinParams,
): MeshData {
  let body = buildPocketBinBody(m, params);
  try {
    if (params.fusedLabel != null) {
      const label = buildFusedLabel(m, font, labelSpecOf(params.fusedLabel), params);
      if (label !== null) {
        const union = m.Manifold.union([body, label]);
        body.delete();
        label.delete();
        if (union.status() !== 'NoError') {
          const status = union.status();
          union.delete();
          throw new Error(`Fused pocket bin union produced an invalid solid: ${status}`);
        }
        body = union;
      }
    }
    return manifoldToMeshData(body);
  } finally {
    body.delete();
  }
}
