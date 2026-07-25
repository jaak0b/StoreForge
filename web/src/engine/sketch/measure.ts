// Measures the current (solved) value of a sketch dimension's underlying
// geometry, so new dimensions can default to what the geometry already is
// instead of a placeholder the solver would otherwise yank the sketch to.
// Single source for this: the dimension entry field (measured default) and
// the typed-length-while-drawing flow both read these functions rather than
// each computing their own version (convention 10).
import { assertNever } from '../plan/types';
import type { Sketch } from './model';

const FALLBACK_MM = 10;

function pointOf(sketch: Sketch, id: string): { x: number; y: number } {
  const entity = sketch.entities.find((e) => e.id === id);
  if (entity === undefined || entity.kind !== 'point') return { x: 0, y: 0 };
  return { x: entity.x, y: entity.y };
}

/**
 * Falls back to a sane default when the measured value is zero, negative or
 * non-finite (degenerate geometry), since dimension mm values must be > 0.
 * This is not a swallowed error under convention 2: no current tool can
 * place a zero-length line or a zero-radius arc/circle, so the fallback
 * should never fire from the shipped UI. It exists so that if a future
 * caller does manage to measure degenerate geometry, the dimension gets a
 * usable placeholder value instead of NaN silently corrupting the sketch;
 * the degenerate case is expected to be visible in review of that future
 * caller, not hidden by this function.
 */
function withFallback(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : FALLBACK_MM;
}

/** The current length of a line, in mm. */
export function measureLineLength(sketch: Sketch, lineId: string): number {
  const line = sketch.entities.find((e) => e.id === lineId);
  if (line === undefined || line.kind !== 'line') return FALLBACK_MM;
  const a = pointOf(sketch, line.p1Id);
  const b = pointOf(sketch, line.p2Id);
  return withFallback(Math.hypot(b.x - a.x, b.y - a.y));
}

/** The current distance between two points, in mm. */
export function measurePointDistance(sketch: Sketch, p1Id: string, p2Id: string): number {
  const a = pointOf(sketch, p1Id);
  const b = pointOf(sketch, p2Id);
  return withFallback(Math.hypot(b.x - a.x, b.y - a.y));
}

/** The current distance between two points along one axis only (|dx| or
 * |dy|), in mm: the measured value for an axis-flavored distance dimension
 * (model.ts's DistanceDimension.axis). Single source (convention 10) for
 * that dimension's measured default and its driven-dimension refresh. */
export function measurePointAxisDistance(
  sketch: Sketch,
  p1Id: string,
  p2Id: string,
  axis: 'x' | 'y',
): number {
  const a = pointOf(sketch, p1Id);
  const b = pointOf(sketch, p2Id);
  return withFallback(Math.abs(axis === 'x' ? b.x - a.x : b.y - a.y));
}

/** The current radius of an arc or circle, in mm. */
export function measureRadius(sketch: Sketch, entityId: string): number {
  const entity = sketch.entities.find((e) => e.id === entityId);
  if (entity === undefined) return FALLBACK_MM;
  if (entity.kind === 'circle') return withFallback(entity.radiusMm);
  if (entity.kind === 'arc') {
    const c = pointOf(sketch, entity.centerId);
    const s = pointOf(sketch, entity.startId);
    return withFallback(Math.hypot(s.x - c.x, s.y - c.y));
  }
  return FALLBACK_MM;
}

/** The current diameter of an arc or circle, in mm. */
export function measureDiameter(sketch: Sketch, entityId: string): number {
  return measureRadius(sketch, entityId) * 2;
}

/**
 * Rounds a millimeter value to 0.01 mm for display and for seeding a
 * measured default: committing an untouched default must store the same
 * rounded figure the user saw (convention 10 single source, used by both the
 * dimension entry field's measured-default seeding and the on-canvas
 * dimension labels).
 */
export function formatMm(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Rounds a degree value to 0.1 degree, for the same display/seeding uses as
 * formatMm above. */
export function formatDegrees(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Parses a dimension field's typed text as a plain positive decimal number.
 * Accepts a comma as the decimal separator and surrounding whitespace;
 * rejects anything else, including a numeric prefix followed by trailing
 * garbage ("36.5abc"), since Number()/parseFloat() would silently accept
 * that prefix (convention 2: no silently swallowed bad input). Returns null
 * for unparseable or non-positive input.
 */
export function parseDimensionValue(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The perpendicular distance from a point to a line's infinite extension, in
 * mm: the standard point-line projection formula, distance = |cross(d, p -
 * a)| / |d| for line direction d = b - a. Used both for the point-line
 * distance dimension's measured default and for the parallel-lines and
 * curve-center selection resolutions that reduce to it (dimensionSelection.ts).
 */
export function measurePointLineDistance(sketch: Sketch, pointId: string, lineId: string): number {
  const line = sketch.entities.find((e) => e.id === lineId);
  if (line === undefined || line.kind !== 'line') return FALLBACK_MM;
  const a = pointOf(sketch, line.p1Id);
  const b = pointOf(sketch, line.p2Id);
  const p = pointOf(sketch, pointId);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return FALLBACK_MM;
  const cross = dx * (p.y - a.y) - dy * (p.x - a.x);
  return withFallback(Math.abs(cross) / len);
}

/**
 * Recomputes every driven dimension's stored value (mm or degrees) from the
 * sketch's current, already-solved geometry, in place. A driven dimension is
 * never enforced by the solver (solve.ts passes PlaneGCS's driving: false for
 * it); this is what keeps its displayed value truthful instead of stale.
 * Framework-agnostic (convention 3); the caller that owns the "just solved"
 * moment, expected to be the binQueue/sketchEditor store's solve result
 * handling, must call this on the freshly solved sketch after every solve
 * before the sketch is shown or persisted. Mutates and also returns `sketch`
 * for chaining.
 */
export function updateDrivenDimensions(sketch: Sketch): Sketch {
  for (const c of sketch.constraints) {
    switch (c.kind) {
      case 'length':
        if (c.driven === true) c.mm = formatMm(measureLineLength(sketch, c.lineId));
        break;
      case 'distance':
        if (c.driven === true) {
          c.mm = formatMm(
            c.axis === undefined
              ? measurePointDistance(sketch, c.p1Id, c.p2Id)
              : measurePointAxisDistance(sketch, c.p1Id, c.p2Id, c.axis),
          );
        }
        break;
      case 'radius':
        if (c.driven === true) c.mm = formatMm(measureRadius(sketch, c.entityId));
        break;
      case 'diameter':
        if (c.driven === true) c.mm = formatMm(measureDiameter(sketch, c.entityId));
        break;
      case 'angle':
        if (c.driven === true) {
          // measureAngleBetweenLines always returns the direct-fold value
          // (the lines' own stored point order, folded to [0,180]); a
          // dimension placed in the supplementary sector (model.ts's
          // AngleDimension.supplementary) must refresh to that sector's own
          // value, its complement, not the direct fold, so a driven angle
          // keeps reporting the same sector it was placed in.
          const directFold = measureAngleBetweenLines(sketch, c.l1Id, c.l2Id);
          c.degrees = formatDegrees(c.supplementary === true ? 180 - directFold : directFold);
        }
        break;
      case 'pointLineDistance':
        if (c.driven === true) c.mm = formatMm(measurePointLineDistance(sketch, c.pointId, c.lineId));
        break;
      case 'coincident':
      case 'horizontal':
      case 'vertical':
      case 'parallel':
      case 'perpendicular':
      case 'tangent':
      case 'symmetric':
        break;
      default:
        assertNever(c);
    }
  }
  return sketch;
}

/** The current angle between two lines, in degrees, folded to 0..180. */
export function measureAngleBetweenLines(sketch: Sketch, l1Id: string, l2Id: string): number {
  const l1 = sketch.entities.find((e) => e.id === l1Id);
  const l2 = sketch.entities.find((e) => e.id === l2Id);
  if (l1 === undefined || l1.kind !== 'line' || l2 === undefined || l2.kind !== 'line') {
    return FALLBACK_MM;
  }
  const a1 = pointOf(sketch, l1.p1Id);
  const b1 = pointOf(sketch, l1.p2Id);
  const a2 = pointOf(sketch, l2.p1Id);
  const b2 = pointOf(sketch, l2.p2Id);
  const angle1 = Math.atan2(b1.y - a1.y, b1.x - a1.x);
  const angle2 = Math.atan2(b2.y - a2.y, b2.x - a2.x);
  let deg = ((angle2 - angle1) * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  if (deg > 180) deg = 360 - deg;
  return deg;
}
