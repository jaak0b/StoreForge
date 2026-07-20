/**
 * Console timing instrumentation for the cutout carve pipeline, and the single
 * home for it. The geometry worker wraps its own stages with these helpers;
 * nothing else in the app prints a timing line.
 *
 * Two reasons the logging lives at the worker layer rather than at each
 * measurement site, and they agree. Timing the pipeline is one concern, so the
 * format, the naming and the eventual decision about whether to keep the
 * logging live in one file instead of being spread across every geometry
 * module that happens to be slow. And the engine has to stay framework
 * agnostic and free of environment side effects: its functions take their
 * dependencies as parameters and return values, so a stage that needs timing
 * returns the figure and this module prints it. The worker is also the only
 * layer that can see a cache hit and a cache miss as different events, which
 * is the distinction the whole instrumentation exists for.
 *
 * It ships enabled, with no flag. Two decisions wait on numbers from real use
 * rather than from one measurement session: where the imported triangle
 * ceiling belongs, and whether the carve is slow enough to justify giving the
 * preview its own worker instance. A flag defaulting to off would mean the one
 * session that mattered was the one where nobody remembered to turn it on.
 * Revisit once both of those are settled, rather than leaving the output
 * permanent by default.
 *
 * Whole milliseconds and raw counts, per figure, never aggregated or averaged,
 * so the numbers read straight off the console and compare without arithmetic.
 * The model name is the stored file name, which is what the model list and
 * every message about a model already use, so one name identifies a model
 * everywhere the user or the owner can see it.
 */
import type { CutoutPrepareTimings } from '../engine/cutout/cutoutBin';

/** The stages the worker times from outside the engine. */
export type CutoutTimingStage = 'STL parse' | 'carve';

/** Every line starts with this, so the pipeline's output filters as one group. */
const PREFIX = 'cutout';

function row(cells: string[]): string {
  return `${PREFIX} ${cells.join(' | ')}`;
}

function ms(elapsedMs: number): string {
  return `${Math.round(elapsedMs)} ms`;
}

function models(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`).join(', ');
  return `${names.length === 1 ? 'model' : 'models'} ${quoted}`;
}

/** Which cached solid a line is about, in the three parts its key is made of. */
export interface TimedModel {
  name: string;
  unitScale: number;
  clearanceMm: number;
}

function keyParts(model: TimedModel): string[] {
  return [`unit scale ${model.unitScale}`, `clearance ${model.clearanceMm} mm`];
}

/**
 * Run one stage, print what it cost, and hand back its result. Used for the
 * stages the worker can wrap from outside: the STL parse and the carve.
 *
 * The time is reported whether the stage succeeded or threw, because a stage
 * that failed slowly is exactly the case the ceiling measurement is looking
 * for, and the failure itself reaches the user through the normal error path.
 */
export function timed<T>(stage: CutoutTimingStage, names: string[], run: () => T): T {
  const startedAt = Date.now();
  try {
    return run();
  } finally {
    console.log(row([stage, models(names), ms(Date.now() - startedAt)]));
  }
}

/**
 * Report an import that had to be performed, with the two expensive stages
 * broken out. The engine returns these figures rather than printing them.
 *
 * The post-simplify triangle count sits beside the simplify time because it is
 * the number that decides where the imported triangle ceiling belongs: the
 * offset's cost follows what simplify leaves behind, not what the file held.
 */
export function reportCutoutModelPrepared(
  model: TimedModel,
  timings: CutoutPrepareTimings,
  triangleCount: number,
  totalMs: number,
): void {
  console.log(
    row([
      'simplify',
      models([model.name]),
      ms(timings.simplifyMs),
      `triangles before ${triangleCount}`,
      `triangles after ${timings.simplifiedTriangleCount}`,
    ]),
  );
  console.log(row(['clearance offset', models([model.name]), ms(timings.offsetMs)]));
  console.log(
    row(['offset cache miss', models([model.name]), ...keyParts(model), ms(totalMs)]),
  );
}

/**
 * Report an import that a cached solid answered, which is the observation the
 * cache exists to produce.
 *
 * This line is deliberately not merged with the miss line. The performance
 * argument for the whole feature is that the clearance offset runs once per
 * model per clearance and never again while the user drags, so the useful
 * figure is not how long an offset took but how often one had to run at all.
 * Printing only the misses would make a working cache look like an idle
 * pipeline, and printing both the same way would hide the difference in
 * exactly the case that matters. It also separates a session that felt slow
 * because one model is pathological from one that felt slow because something
 * is invalidating the cache more often than it should.
 */
export function reportCutoutModelCacheHit(model: TimedModel): void {
  console.log(
    row([
      'offset cache hit',
      models([model.name]),
      ...keyParts(model),
      'reused the cached solid',
    ]),
  );
}
