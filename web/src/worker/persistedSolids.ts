/**
 * The worker's real implementation of the PersistedSolids tier: the bridge
 * between the in-memory solid caches (worker/cutoutModels.ts), the record
 * format and its trust checks (engine/cutout/persistedSolids.ts), and the
 * IndexedDB store (src/solidStore.ts). Workers have IndexedDB access of their
 * own, so the records are read and written from here without involving the
 * main thread.
 *
 * Every failure path is surfaced and none is fatal. A load that fails or
 * yields an untrusted record returns null, which the callers treat as a plain
 * cache miss and recompute from; the error is logged so a corrupted database
 * does not degrade the cache silently. A save runs fire-and-forget and logs
 * its failure, because a failed cache write must not fail the carve or import
 * that produced the solid.
 */
import type { ManifoldToplevel } from 'manifold-3d';
import { cutoutModelKey } from '../engine/cutout/cutoutBin';
import {
  decodePreparedCutoutModel,
  decodeSweptSolid,
  encodePreparedCutoutModel,
  encodeSweptSolid,
} from '../engine/cutout/persistedSolids';
import { getSolidRecord, putSolidRecord } from '../solidStore';
import type { PersistedSolids } from './cutoutModels';

/**
 * The persisted tier bound to a loaded manifold instance, which decoding
 * needs to rebuild solids on the WASM heap.
 */
export function persistedSolidsFor(m: ManifoldToplevel): PersistedSolids {
  return {
    async loadPrepared(spec) {
      const key = cutoutModelKey(spec.modelSourceId, spec.unitScale, spec.clearanceMm);
      try {
        const record = await getSolidRecord(key);
        if (record === null || record.kind !== 'offset') return null;
        return decodePreparedCutoutModel(m, record);
      } catch (error) {
        console.error('Loading a persisted prepared cutout solid failed.', error);
        return null;
      }
    },
    savePrepared(spec, prepared) {
      const key = cutoutModelKey(spec.modelSourceId, spec.unitScale, spec.clearanceMm);
      putSolidRecord(encodePreparedCutoutModel(key, prepared)).catch((error) => {
        console.error('Persisting a prepared cutout solid failed.', error);
      });
    },
    async loadSwept(key) {
      try {
        const record = await getSolidRecord(key);
        if (record === null || record.kind !== 'swept') return null;
        return decodeSweptSolid(m, record);
      } catch (error) {
        console.error('Loading a persisted swept cutout solid failed.', error);
        return null;
      }
    },
    saveSwept(key, entry) {
      putSolidRecord(encodeSweptSolid(key, entry)).catch((error) => {
        console.error('Persisting a swept cutout solid failed.', error);
      });
    },
  };
}
