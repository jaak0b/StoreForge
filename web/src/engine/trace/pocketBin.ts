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
  FLOOR_TOP,
  HEIGHT_UNIT,
  LIP_HEIGHT,
  OUTER_CORNER_RADIUS,
  WALL_THICKNESS,
} from '../gridfinity/constants';
import {
  buildLabeledBody,
  buildWeldedLabel,
  manifoldToMeshData,
  roundedRectPolygon,
} from '../gridfinity/binGenerator';
import type { LabeledBinMeshes, LabeledBinParams, MeshData } from '../gridfinity/types';

/** A labeled bin plus the tools whose pockets are sunk into its interior. */
export interface PocketBinParams extends LabeledBinParams {
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
  params: LabeledBinParams,
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
    for (const section of cutSections) section.delete();
  }
}

/**
 * The smallest gridX by gridY footprint whose interior cavity contains every
 * placed pocket (outline and finger holes) with at least marginMm of clear
 * interior around it. Placements are bin-local mm about the origin, so the
 * fit is checked at the given positions. Also rejects overlapping placements.
 * The first guess comes from the bounding box; the rounded interior corners
 * can push a corner-hugging layout one grid unit up, so the exact containment
 * check drives the final answer.
 */
export function autoGridSize(
  m: ManifoldToplevel,
  tools: TracedTool[],
  placements: ToolPlacement[],
  marginMm: number,
): { gridX: number; gridY: number } {
  if (marginMm < 0) {
    throw new RangeError(`margin must be >= 0, got ${marginMm}`);
  }
  if (placements.length === 0) {
    throw new Error('Place at least one tool before sizing the bin.');
  }
  const placed = placeTools(m, tools, placements);
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

  // Bounding half-extent of everything the pockets cut, about the origin.
  let halfX = 0;
  let halfY = 0;
  for (const pocket of placed) {
    for (const p of pocket.outline.outer) {
      halfX = Math.max(halfX, Math.abs(p.x));
      halfY = Math.max(halfY, Math.abs(p.y));
    }
    for (const hole of pocket.fingerHoles) {
      const r = hole.diameterMm / 2;
      halfX = Math.max(halfX, Math.abs(hole.x) + r);
      halfY = Math.max(halfY, Math.abs(hole.y) + r);
    }
  }

  const cellsFor = (halfExtent: number): number => {
    let cells = 1;
    while (binInteriorSizeMm(cells) / 2 < halfExtent + marginMm) cells += 1;
    return cells;
  };
  const guessX = cellsFor(halfX);
  const guessY = cellsFor(halfY);

  // Margin-grown cut section: containment of this inside the interior gives
  // marginMm of clear interior all round, including at the rounded corners.
  let grownCut: CrossSection | null = null;
  for (const pocket of placed) {
    const section = placedCutSection(m, pocket);
    const grown = marginMm > 0 ? section.offset(marginMm, 'Round') : section;
    if (marginMm > 0) section.delete();
    if (grownCut === null) {
      grownCut = grown;
    } else {
      const merged: CrossSection = grownCut.add(grown);
      grownCut.delete();
      grown.delete();
      grownCut = merged;
    }
  }

  try {
    // The bounding-box guess can only miss because of the interior corner
    // rounding, which one extra grid unit per axis always covers.
    const candidates: Array<{ gridX: number; gridY: number }> = [];
    for (const gx of [guessX, guessX + 1]) {
      for (const gy of [guessY, guessY + 1]) {
        candidates.push({ gridX: gx, gridY: gy });
      }
    }
    candidates.sort((a, b) => a.gridX * a.gridY - b.gridX * b.gridY);
    for (const candidate of candidates) {
      const interior = interiorSection(m, candidate.gridX, candidate.gridY);
      const outside = grownCut!.subtract(interior);
      const fits = outside.isEmpty();
      outside.delete();
      interior.delete();
      if (fits) return candidate;
    }
    throw new Error(
      'The placed tools do not fit a bin centred on the layout. Move the tools closer to the centre.',
    );
  } finally {
    grownCut?.delete();
  }
}

/**
 * Build the pocket-bin body and label as manifolds. The standard labeled bin
 * body (including the label shelf when a label is present) is built first,
 * its interior cavity is filled solid from the floor top up to the nominal
 * bin top so the pockets have material to sink into, and the pockets are
 * subtracted last, so a pocket reaching under the label shelf always wins
 * over the shelf's support ribs. Each pocket is cut from above the bin top
 * down to bodyTop minus its depth; finger holes are cut further, down to the
 * top of the interior floor. They are grab reliefs, not through-holes: the
 * floor plate under them stays intact.
 */
export function buildPocketBinSolids(
  m: ManifoldToplevel,
  font: Font,
  params: PocketBinParams,
): { body: Manifold; label: Manifold | null } {
  const placed = placeTools(m, params.tools, params.placements);
  validatePocketLayout(m, params, placed);

  const bodyTop = params.heightUnits * HEIGHT_UNIT;
  const solidTop = params.stackingLip ? bodyTop + LIP_HEIGHT : bodyTop;
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

  const shelved = buildLabeledBody(m, params);
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
  if (body.status() !== 'NoError') {
    body.delete();
    throw new Error(`Pocket bin generation produced an invalid solid: ${body.status()}`);
  }

  let label: Manifold | null = null;
  try {
    label = buildWeldedLabel(m, font, params, body);
  } catch (error) {
    body.delete();
    throw error;
  }
  return { body, label };
}

/**
 * Generate a pocket bin as separate body and label meshes, mirroring
 * generateLabeledBin so the label can keep its own color in the 3MF.
 */
export function generatePocketBin(
  m: ManifoldToplevel,
  font: Font,
  params: PocketBinParams,
): LabeledBinMeshes {
  const { body, label } = buildPocketBinSolids(m, font, params);
  try {
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
 * Generate a pocket bin as one unioned mesh, mirroring
 * generateLabeledBinUnion for the single-mesh STL download.
 */
export function generatePocketBinUnion(
  m: ManifoldToplevel,
  font: Font,
  params: PocketBinParams,
): MeshData {
  const { body, label } = buildPocketBinSolids(m, font, params);
  let union: Manifold | null = null;
  try {
    if (!label) return manifoldToMeshData(body);
    union = m.Manifold.union([body, label]);
    if (union.status() !== 'NoError') {
      throw new Error(`Pocket bin union produced an invalid solid: ${union.status()}`);
    }
    return manifoldToMeshData(union);
  } finally {
    body.delete();
    label?.delete();
    union?.delete();
  }
}
