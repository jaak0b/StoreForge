// Gridfinity bins with tool-shaped pockets, in the style of a tool-trace
// (shadow board) insert. Builds on the standard bin generator: the bin is
// generated as usual, its interior cavity is filled solid from the floor top
// to the nominal bin top, and each placed tool's resolved outline is then
// subtracted from the bin top down to its pocket depth, with vertical
// finger-hole reliefs so the tool can be lifted out. Framework-agnostic; the
// ManifoldToplevel and Font are injected as everywhere else in the engine.
import type {
  CrossSection,
  ExecutionContext,
  Manifold,
  ManifoldToplevel,
  SimplePolygon,
} from 'manifold-3d';
import type { Font } from 'opentype.js';
import type { FingerHole, MmPoint, TracedOutline, TracedTool, ToolPlacement } from './types';
import { CHORDAL_TOLERANCE_MM, fingerHoleOutline, resolvedToolOutline } from './edit';
import { FLOOR_TOP, HEIGHT_UNIT, LIP_HEIGHT } from '../gridfinity/constants';
import {
  finishBinPartMeshes,
  finishBinUnionMesh,
} from '../gridfinity/binGenerator';
import {
  buildCarvedBinBody,
  CARVE_OVERLAP_EPS,
  interiorSection,
  labelStructureStrip,
  maxCarveDepthMm,
} from '../gridfinity/carvedBin';
import { circleSegments } from '../geometry/circleSegments';
import { applyCavityEditsMemoized, type CavityEditedBodyMemo } from '../carve/cavityEdits';
import { sweepCutterUpward, validateDraftAngleDeg } from '../carve/sweep';
import type { CavityEdit } from '../plan/types';
import type { BinParams, MeshData, PartMeshes, SlottedBinParams } from '../gridfinity/types';

/** A slotted bin plus the tools whose pockets are sunk into its interior. */
export interface PocketBinParams extends SlottedBinParams {
  tools: TracedTool[];
  placements: ToolPlacement[];
  /** Manual cavity edits applied after the pocket carve, before the label stage. Absent means none. */
  edits?: CavityEdit[];
  /**
   * Memo for the edited body, supplied by the worker so appending one edit to
   * an unchanged carve reuses the previous edited body. Absent for direct
   * callers, which fold every edit; the result is identical by construction.
   */
  editedMemo?: CavityEditedBodyMemo;
  /** Identity of the carve the edits apply to, required when editedMemo is set. */
  editedRecipeKey?: string;
}

/** A tool resolved and moved into bin-local mm, ready to cut as a pocket. */
export interface PlacedPocket {
  tool: TracedTool;
  /** The tool's resolved parts, translated into bin-local mm. */
  outlines: TracedOutline[];
  /** The tool's finger holes, translated into bin-local mm. */
  fingerHoles: FingerHole[];
  pocketDepthMm: number;
  /** The placement's draft angle; 0 means straight vertical pocket walls. */
  draftAngleDeg: number;
}

/**
 * Resolve each placement against its tool and translate the resolved parts
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
    const resolvedParts = resolvedToolOutline(m, tool);
    const move = (p: MmPoint): MmPoint => ({
      x: p.x + placement.xMm,
      y: p.y + placement.yMm,
    });
    return {
      tool,
      outlines: resolvedParts.map((resolved) => ({
        outer: resolved.outer.map(move),
        holes: resolved.holes.map((loop) => loop.map(move)),
      })),
      fingerHoles: tool.fingerHoles.map((hole) => ({
        ...hole,
        x: hole.x + placement.xMm,
        y: hole.y + placement.yMm,
        ...(hole.x2 !== undefined && hole.y2 !== undefined
          ? { x2: hole.x2 + placement.xMm, y2: hole.y2 + placement.yMm }
          : {}),
      })),
      pocketDepthMm: placement.pocketDepthMm,
      draftAngleDeg: placement.draftAngleDeg,
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
 * Cross-section of every part of a placed pocket combined: one EvenOdd
 * cross-section per part (outer plus that part's own holes), unioned together
 * with CrossSection.add, the established boolean-union primitive. A part's
 * clearance offset can grow it into an adjacent part's footprint (they no
 * longer stay disjoint the way the unclearanced parts do), so a single flat
 * EvenOdd fill over every part's concatenated loops is wrong where two parts'
 * grown outlines overlap: the shared strip is covered twice and an EvenOdd
 * fill cancels it back out, carving a phantom wall between two parts that
 * should print as one merged pocket. Unioning each part's own fill sidesteps
 * that: CrossSection.add returns the true union regardless of overlap.
 */
function outlinesSection(m: ManifoldToplevel, outlines: TracedOutline[]): CrossSection {
  let union: CrossSection | null = null;
  for (const outline of outlines) {
    const part = outlineSection(m, outline);
    if (union === null) {
      union = part;
      continue;
    }
    const merged = union.add(part);
    union.delete();
    part.delete();
    union = merged;
  }
  return union ?? new m.CrossSection([], 'EvenOdd');
}

/**
 * How far a drafted pocket's walls flare outward at the rim, in mm: a wall
 * leaning outward by the draft angle over the pocket's depth moves the rim
 * out by tan(angle) times depth. 0 for a straight (angle 0) pocket.
 */
function draftFlareMm(placed: PlacedPocket): number {
  if (placed.draftAngleDeg === 0) return 0;
  return Math.tan((placed.draftAngleDeg * Math.PI) / 180) * placed.pocketDepthMm;
}

/**
 * Cross-section of a placed pocket's outline at the rim: the base outline
 * grown outward by the draft flare via CrossSection.offset with round joins
 * (the same primitive and chordal budget the clearance offset in edit.ts
 * spends). At draft angle 0 this is the base outline itself.
 */
function draftedOutlineSection(m: ManifoldToplevel, placed: PlacedPocket): CrossSection {
  const base = outlinesSection(m, placed.outlines);
  const flareMm = draftFlareMm(placed);
  if (flareMm === 0) return base;
  const grown = base.offset(
    flareMm,
    'Round',
    undefined,
    circleSegments(flareMm, CHORDAL_TOLERANCE_MM),
  );
  base.delete();
  return grown;
}

/**
 * Cross-section of everything a placed tool cuts from the bin: its pocket
 * outline plus its finger-hole circles. Used for the wall-clearance check, so
 * a finger hole poking into the wall is caught like the outline itself. With
 * `atRim` the outline is taken at the drafted rim (its widest point); the
 * finger holes are straight grab reliefs and never flare.
 */
function placedCutSection(
  m: ManifoldToplevel,
  placed: PlacedPocket,
  atRim: boolean,
): CrossSection {
  let section = atRim
    ? draftedOutlineSection(m, placed)
    : outlinesSection(m, placed.outlines);
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
 * The deepest pocket a bin of the given height allows, the shared carve
 * stage's depth limit under this flow's own name; the depth validation message
 * quotes it. Re-exported rather than restated so both flows keep one figure.
 */
export const maxPocketDepthMm = maxCarveDepthMm;

/** True when the two cross-sections share any area. */
function sectionsOverlap(a: CrossSection, b: CrossSection): boolean {
  const overlap = a.intersect(b);
  const result = !overlap.isEmpty();
  overlap.delete();
  return result;
}

/**
 * Result of validating a pocket layout: warnings about legal but probably
 * unintended overlaps between different tools' pockets. Returned, never
 * thrown: two tools' pockets merging into one cavity is the user's decision
 * to make, mirroring the cutout flow's CutoutPlacementWarning.
 */
export interface PocketLayoutValidation {
  warnings: string[];
}

/**
 * Validate a pocket layout against the bin parameters: pockets cannot share a
 * bin with divider walls, every pocket depth must stay above the interior
 * floor, and every pocket (outline and finger holes) must stay inside the
 * interior cavity. These are user-fixable and error with user-worded
 * messages. An overlap between two DIFFERENT tools' pockets is no longer an
 * error: it returns as a warning, since the two pockets simply merge into one
 * printed cavity. Parts belonging to the same tool are never compared against
 * each other (they are disjoint by construction and combined into one
 * cross-section per tool by outlinesSection).
 */
export function validatePocketLayout(
  m: ManifoldToplevel,
  params: BinParams & { labelSlot?: boolean } & Pick<SlottedBinParams, 'fusedLabel'>,
  placed: PlacedPocket[],
): PocketLayoutValidation {
  if (params.walls.length > 0) {
    throw new Error(
      'Tool pockets cannot be combined with divider walls. Remove the dividers to add pockets.',
    );
  }
  const maxDepth = maxPocketDepthMm(params.heightUnits);
  for (const pocket of placed) {
    validateDraftAngleDeg(pocket.draftAngleDeg);
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
  // The checks judge the drafted rim, the pocket's widest cross-section; at
  // draft angle 0 it is the base outline itself.
  const cutSections = placed.map((pocket) => placedCutSection(m, pocket, true));
  // The insert seat and its support structure cannot be cut into, so pockets
  // must stay clear of the label structure's plan strip. The strip and the
  // reasoning behind it belong to the shared carve stage, which every carve
  // flow protects the same way; only the message is this flow's own.
  const structure = labelStructureStrip(m, params);
  const slotStrip = structure?.section ?? null;
  const structureName = structure?.name ?? '';
  const warnings: string[] = [];
  try {
    // Whether a violation of a rim-level check disappears when the pocket's
    // base outline is judged instead: then the draft flare alone is the cause,
    // and the message says so.
    const flareIsTheCause = (i: number, check: (section: CrossSection) => boolean): boolean => {
      if (draftFlareMm(placed[i]) === 0) return false;
      const base = placedCutSection(m, placed[i], false);
      const baseViolates = check(base);
      base.delete();
      return !baseViolates;
    };
    for (let i = 0; i < placed.length; i += 1) {
      const outside = cutSections[i].subtract(interior);
      const pokesOut = !outside.isEmpty();
      outside.delete();
      if (pokesOut) {
        const flareCause = flareIsTheCause(i, (section) => {
          const baseOutside = section.subtract(interior);
          const violates = !baseOutside.isEmpty();
          baseOutside.delete();
          return violates;
        });
        throw new Error(
          flareCause
            ? `The pocket for "${placed[i].tool.name}" fits at its base, but its draft ` +
              'flare reaches into the bin wall at the rim. Reduce the draft angle, move ' +
              'the pocket away from the walls, or use a larger bin.'
            : `The pocket for "${placed[i].tool.name}" reaches into the bin wall. ` +
              'Move it away from the walls or use a larger bin.',
        );
      }
      if (slotStrip !== null && sectionsOverlap(cutSections[i], slotStrip)) {
        const flareCause = flareIsTheCause(i, (section) =>
          sectionsOverlap(section, slotStrip),
        );
        throw new Error(
          flareCause
            ? `The draft flare of the pocket for "${placed[i].tool.name}" reaches under ` +
              `the ${structureName}. Reduce the draft angle or move the pocket away ` +
              'from the front wall.'
            : `The pocket for "${placed[i].tool.name}" reaches under the ${structureName}. ` +
              'Move it away from the front wall or use a deeper bin.',
        );
      }
    }
    // Different tools' pockets are allowed to overlap: they merge into one
    // printed cavity, which is legal but probably worth flagging. Parts of
    // the same tool are never compared here since i and j always name two
    // distinct placements (distinct tools), never two parts of one tool.
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = draftedOutlineSection(m, placed[i]);
        const b = draftedOutlineSection(m, placed[j]);
        const overlapping = sectionsOverlap(a, b);
        a.delete();
        b.delete();
        if (overlapping) {
          warnings.push(
            `The pockets for "${placed[i].tool.name}" and "${placed[j].tool.name}" overlap ` +
              'and will merge into one cavity.',
          );
        }
      }
    }
  } finally {
    interior.delete();
    slotStrip?.delete();
    for (const section of cutSections) section.delete();
  }
  return { warnings };
}

/**
 * Build the pocket-bin body as a manifold: place the tools, validate the
 * layout, build one cutter per pocket, and hand them to the shared carve
 * stage, which fills the interior, subtracts them and restores the slot.
 *
 * Each pocket is cut from above the bin top down to bodyTop minus its depth;
 * finger holes are cut further, down to the top of the interior floor. They
 * are grab reliefs, not through-holes: the floor plate under them stays
 * intact. The cutters reach past the solid top so a pocket is always open at
 * the top, which is this flow's own property and not the shared stage's.
 *
 * `ctx` is handed straight to the shared carve stage, which attaches it to the
 * one eager operation of the carve. A preview passes the context it can cancel
 * when the user supersedes it; an export passes nothing, exactly as the cutout
 * flow does.
 */
/** What a pocket-bin carve produces beyond the solid itself: see PocketLayoutValidation. */
export interface PocketCarve {
  body: Manifold;
  warnings: string[];
}

export function buildPocketBinBody(
  m: ManifoldToplevel,
  params: PocketBinParams,
  ctx?: ExecutionContext,
): Manifold {
  // Overlap between different tools' pockets is a warning, not a blocker: the
  // carve proceeds and the merged region simply prints as one cavity. This
  // straight-through build (used by the final single-shot mesh and STL
  // exports, which have nothing to show a warning on) discards them, exactly
  // as it always proceeded past a legal overlap before this rule existed; a
  // caller that needs them calls buildPocketBinBodyWithWarnings instead.
  return buildPocketBinBodyWithWarnings(m, params, ctx).body;
}

/**
 * Build the pocket-bin body along with its non-blocking placement warnings
 * (currently just cross-tool pocket overlaps). See buildPocketBinBody for the
 * build itself; this is the same build, with the warnings threaded out for a
 * caller (the live preview) that can show them.
 */
export function buildPocketBinBodyWithWarnings(
  m: ManifoldToplevel,
  params: PocketBinParams,
  ctx?: ExecutionContext,
): PocketCarve {
  const placed = placeTools(m, params.tools, params.placements);
  const { warnings } = validatePocketLayout(m, params, placed);

  const bodyTop = params.heightUnits * HEIGHT_UNIT;
  const solidTop = bodyTop + LIP_HEIGHT;

  const cutters: Manifold[] = [];
  for (const pocket of placed) {
    const pocketBottom = bodyTop - pocket.pocketDepthMm;
    const section = outlinesSection(m, pocket.outlines);
    const extruded = section
      .extrude(solidTop + CARVE_OVERLAP_EPS - pocketBottom)
      .translate(0, 0, pocketBottom);
    section.delete();
    // A drafted pocket's cutter is swept upward at the draft angle, so its
    // walls lean outward toward the rim. The zero-clearance branch of the
    // sweep applies: the extruded outline is exact, so nothing is simplified
    // and the sweep cone facets against its own radius.
    cutters.push(
      pocket.draftAngleDeg > 0
        ? sweepCutterUpward(m, extruded, {
            heightUnits: params.heightUnits,
            draftAngleDeg: pocket.draftAngleDeg,
            clearanceMm: 0,
          })
        : extruded,
    );
    for (const hole of pocket.fingerHoles) {
      const circle = outlineSection(m, fingerHoleOutline(hole));
      cutters.push(
        circle
          .extrude(solidTop + CARVE_OVERLAP_EPS - FLOOR_TOP)
          .translate(0, 0, FLOOR_TOP),
      );
      circle.delete();
    }
  }

  let body = buildCarvedBinBody(m, params, cutters, 'Pocket bin', ctx);
  const edits = params.edits ?? [];
  if (edits.length > 0) {
    // The un-carved solid bin body: the same carve stage with no cutters, so
    // the Add clamp envelope is derived where the carve already derives it.
    // buildCarvedBinBody only reads the CarvedBinParams fields it needs, so
    // params (a superset, carrying edits and the memo fields too) is passed
    // through a variable rather than an object literal to avoid an excess
    // property error on fields it structurally ignores.
    const makeBinSolid = (): Manifold => buildCarvedBinBody(m, params, [], 'Pocket bin');
    body =
      params.editedMemo !== undefined && params.editedRecipeKey !== undefined
        ? applyCavityEditsMemoized(m, body, makeBinSolid, edits, {
            store: params.editedMemo,
            recipeKey: params.editedRecipeKey,
          })
        : applyCavityEditsMemoized(m, body, makeBinSolid, edits);
  }
  return { body, warnings };
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
  ctx?: ExecutionContext,
): PartMeshes {
  return finishBinPartMeshes(m, font, buildPocketBinBody(m, params, ctx), params);
}

/** What a pocket-bin preview carve produces beyond its meshes: see PocketCarve. */
export interface PocketMeshesResult {
  meshes: PartMeshes;
  warnings: string[];
}

/**
 * Generate a pocket bin's preview meshes along with its non-blocking
 * placement warnings. The live preview flow's own entry point; the
 * single-shot mesh and STL exports use generatePocketBin/generatePocketBinUnion
 * instead, which have nothing to show a warning on.
 */
export function generatePocketBinWithWarnings(
  m: ManifoldToplevel,
  font: Font,
  params: PocketBinParams,
  ctx?: ExecutionContext,
): PocketMeshesResult {
  const { body, warnings } = buildPocketBinBodyWithWarnings(m, params, ctx);
  return { meshes: finishBinPartMeshes(m, font, body, params), warnings };
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
  return finishBinUnionMesh(
    m,
    font,
    buildPocketBinBody(m, params),
    params,
    'Fused pocket bin',
  );
}
