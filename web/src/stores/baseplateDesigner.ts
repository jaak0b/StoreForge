import { defineStore } from 'pinia';
import {
  MAGNET_DIAMETER_DEFAULT,
  MAGNET_HEIGHT_DEFAULT,
  type BaseplateBrim,
  type BaseplateMagnets,
  type BaseplateParams,
} from '../engine/baseplate/constants';
import { baseplateParamsOf } from '../engine/plan/geometry';
import type { BaseplateProduct } from '../engine/plan/types';

/** Whether an optional hole feature is stamped into every cell or absent. */
export type HoleMode = 'none' | 'full';

/**
 * The Baseplate tab's form state: raw field values only. The magnet collapse
 * (magnet mode none means null magnets) lives in the getter and nowhere else,
 * so a value the user typed and then toggled off is never persisted.
 * `product` is the single place a form value becomes a stored field, and
 * `params` derives from it through baseplateParamsOf, the same mapping the
 * export path uses, so the preview provably shows what the queue row will
 * export.
 */
export const useBaseplateDesigner = defineStore('baseplateDesigner', {
  state: () => ({
    unitsX: 2,
    unitsY: 2,
    magnetMode: 'none' as HoleMode,
    magnetDiameterMm: MAGNET_DIAMETER_DEFAULT,
    magnetHeightMm: MAGNET_HEIGHT_DEFAULT,
    screwHoleMode: 'none' as HoleMode,
    connectable: false,
    notes: '',
    /**
     * The four brim sides in mm, editable in the form's More options section.
     * A drawer-fill plate's brim is planned, but a queue edit loads it here
     * so the user can see and adjust it. All four default to 0 (and reset to
     * 0), and the getter collapses an all-zero brim to an absent one, so a
     * plain plate never carries a brim object.
     */
    brimLeftMm: 0,
    brimRightMm: 0,
    brimFrontMm: 0,
    brimBackMm: 0,
  }),
  getters: {
    /** The stored magnet dimensions: the single magnet-mode collapse. */
    magnets(state): BaseplateMagnets | null {
      return state.magnetMode === 'full'
        ? { diameterMm: state.magnetDiameterMm, heightMm: state.magnetHeightMm }
        : null;
    },
    /**
     * The stored brim: the single all-zero collapse. An empty number field
     * counts as 0, and a plate whose four sides are all 0 gets no brim object
     * at all, matching the plan file where a plain plate has no brim field.
     */
    brim(state): BaseplateBrim | undefined {
      const clean = (raw: number): number =>
        typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
      const leftMm = clean(state.brimLeftMm);
      const rightMm = clean(state.brimRightMm);
      const frontMm = clean(state.brimFrontMm);
      const backMm = clean(state.brimBackMm);
      if (leftMm === 0 && rightMm === 0 && frontMm === 0 && backMm === 0) return undefined;
      return { leftMm, rightMm, frontMm, backMm };
    },
    /** The product the form currently designs, built from the collapsed getters. */
    product(state): BaseplateProduct {
      return {
        kind: 'baseplate',
        unitsX: state.unitsX,
        unitsY: state.unitsY,
        magnets: this.magnets,
        screwHoles: state.screwHoleMode === 'full',
        connectable: state.connectable,
        brim: this.brim,
      };
    },
    /** The geometry parameters, derived from the product, never built alongside it. */
    params(): BaseplateParams {
      return baseplateParamsOf(this.product);
    },
  },
  actions: {
    /**
     * Prefills the form from a stored product for editing. Stored null
     * magnets load as the feature toggled off with the fields back at their
     * defaults; a stored value loads with its toggle on. Resetting to a new
     * design is Pinia's $reset.
     */
    loadProduct(product: BaseplateProduct): void {
      this.unitsX = product.unitsX;
      this.unitsY = product.unitsY;
      this.magnetMode = product.magnets !== null ? 'full' : 'none';
      this.magnetDiameterMm = product.magnets?.diameterMm ?? MAGNET_DIAMETER_DEFAULT;
      this.magnetHeightMm = product.magnets?.heightMm ?? MAGNET_HEIGHT_DEFAULT;
      this.screwHoleMode = product.screwHoles ? 'full' : 'none';
      this.connectable = product.connectable;
      this.brimLeftMm = product.brim?.leftMm ?? 0;
      this.brimRightMm = product.brim?.rightMm ?? 0;
      this.brimFrontMm = product.brim?.frontMm ?? 0;
      this.brimBackMm = product.brim?.backMm ?? 0;
    },
  },
});
