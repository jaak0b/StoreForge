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
     * Brim of the loaded product, carried through an edit unchanged. The form
     * has no brim controls: a drawer-fill plate's brim comes from the planner
     * and only survives the load-edit-save round trip here. Undefined for a
     * plain plate and after $reset, so a new design never inherits one.
     */
    brim: undefined as BaseplateBrim | undefined,
  }),
  getters: {
    /** The stored magnet dimensions: the single magnet-mode collapse. */
    magnets(state): BaseplateMagnets | null {
      return state.magnetMode === 'full'
        ? { diameterMm: state.magnetDiameterMm, heightMm: state.magnetHeightMm }
        : null;
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
        brim: state.brim,
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
      this.brim = product.brim === undefined ? undefined : { ...product.brim };
    },
  },
});
