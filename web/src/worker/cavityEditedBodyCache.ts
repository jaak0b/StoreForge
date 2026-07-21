/**
 * The worker's single-entry memo for a carved bin's edited body, and the
 * recipe-key derivation both carving flows key it under.
 *
 * A carved-interior bin (a cutout bin or a traced pocket bin) folds its manual
 * cavity edits onto the freshly carved body. Both flows want the same thing:
 * appending one more stroke onto an unchanged carve should reuse the body
 * folded up to the previous stroke instead of refolding every earlier edit.
 * That is exactly what applyCavityEditsMemoized does with a CavityEditedBodyMemo
 * and a recipe key, so the memo and the key live here, flow-neutral, and each
 * flow instantiates its own cache (so the two flows never evict each other's
 * body) and supplies its own carve-identity payload.
 *
 * This module holds no manifold instance beyond the borrowed handles the memo
 * stores, and performs no geometry itself.
 */
import type { Manifold } from 'manifold-3d';
import type { CavityEditedBodyMemo } from '../engine/carve/cavityEdits';

/**
 * The single-entry memo for the edited body: the body after folding every
 * cavity edit onto the current carve. Unlike the model and swept caches, this
 * needs no PinRegistry, because the memoized body is only ever borrowed and
 * replaced inside the synchronous eager carve (get, fold, put with no await
 * between), so no suspended operation can observe a stale handle. A single
 * entry is enough: the memo only ever serves the append of one edit onto the
 * immediately preceding carve, so keeping more would never be consulted, per
 * the spec's single-entry contract. `clear()` is called when a plan mutation
 * could strand a body derived from solids that were just released.
 */
export class CavityEditedBodyCache implements CavityEditedBodyMemo {
  private entry: { key: string; body: Manifold } | null = null;

  get(key: string): Manifold | null {
    return this.entry !== null && this.entry.key === key ? this.entry.body : null;
  }

  /** Stores the edited body under this key, deleting the superseded entry. */
  put(key: string, body: Manifold): void {
    this.entry?.body.delete();
    this.entry = { key, body };
  }

  clear(): void {
    this.entry?.body.delete();
    this.entry = null;
  }

  /** How many bodies are held: 0 or 1. For diagnostics and tests. */
  get size(): number {
    return this.entry === null ? 0 : 1;
  }
}

/**
 * The carve-identity recipe key both edited-body memos are keyed under: the
 * deterministic JSON of everything that changes the carved body the edits fold
 * onto. Each flow supplies its own identity payload (a cutout names its models,
 * a pocket its tools and placements); the one invariant both share, and the
 * reason this lives in a single place, is that the edits themselves are never
 * part of the payload. Excluding them is what lets appending one edit reuse the
 * previous carve's edited body instead of missing on every keystroke of a
 * stroke, so the two flows cannot drift on it (rule 10).
 */
export function carveRecipeKey(identity: unknown): string {
  return JSON.stringify(identity);
}
