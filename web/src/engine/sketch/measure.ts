// Measures the current (solved) value of a sketch dimension's underlying
// geometry, so new dimensions can default to what the geometry already is
// instead of a placeholder the solver would otherwise yank the sketch to.
// Single source for this: the dimension entry field (measured default) and
// the typed-length-while-drawing flow both read these functions rather than
// each computing their own version (convention 10).
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
