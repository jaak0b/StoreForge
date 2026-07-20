import { defineStore } from 'pinia';
import { PITCH } from '../engine/gridfinity/constants';
import {
  MAGNET_DIAMETER_DEFAULT,
  MAGNET_HEIGHT_DEFAULT,
  type BaseplateMagnets,
  type BaseplateParams,
} from '../engine/baseplate/constants';
import { baseplateSpanMm } from '../engine/baseplate/generator';
import { baseplateParamsOf } from '../engine/plan/geometry';
import type { BaseplateProduct } from '../engine/plan/types';

/** Whether an optional hole feature is stamped into every cell or absent. */
export type HoleMode = 'none' | 'full';

/**
 * The Baseplate tab's form state: raw field values only. The two collapses
 * (custom size off means null spans, magnet mode none means null magnets)
 * live in the getters and nowhere else, so a value the user typed and then
 * toggled off is never persisted. `product` is the single place a form value
 * becomes a stored field, and `params` derives from it through
 * baseplateParamsOf, the same mapping the export path uses, so the preview
 * provably shows what the queue row will export.
 */
export const useBaseplateDesigner = defineStore('baseplateDesigner', {
  state: () => ({
    unitsX: 2,
    unitsY: 2,
    /**
     * Whether the last column and row are shortened. Form-only: when off, the
     * product stores null spans, so "full pitch" is never persisted as the
     * literal pitch.
     */
    customSize: false,
    customXMm: PITCH,
    customYMm: PITCH,
    magnetMode: 'none' as HoleMode,
    magnetDiameterMm: MAGNET_DIAMETER_DEFAULT,
    magnetHeightMm: MAGNET_HEIGHT_DEFAULT,
    screwHoleMode: 'none' as HoleMode,
    connectable: false,
    notes: '',
  }),
  getters: {
    /** The stored span of the last column: the single custom-size collapse on X. */
    spanX(state): number | null {
      return state.customSize ? state.customXMm : null;
    },
    /** The stored span of the last row: the single custom-size collapse on Y. */
    spanY(state): number | null {
      return state.customSize ? state.customYMm : null;
    },
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
        customXMm: this.spanX,
        customYMm: this.spanY,
        magnets: this.magnets,
        screwHoles: state.screwHoleMode === 'full',
        connectable: state.connectable,
      };
    },
    /** The geometry parameters, derived from the product, never built alongside it. */
    params(): BaseplateParams {
      return baseplateParamsOf(this.product);
    },
    /** Total plate width in mm, for the size readout. */
    widthMm(state): number {
      return baseplateSpanMm(state.unitsX, this.spanX);
    },
    /** Total plate depth in mm, for the size readout. */
    depthMm(state): number {
      return baseplateSpanMm(state.unitsY, this.spanY);
    },
  },
  actions: {
    /**
     * Prefills the form from a stored product for editing. A stored null span
     * or null magnets loads as the feature toggled off with the fields back
     * at their defaults; a stored value loads with its toggle on.
     * Resetting to a new design is Pinia's $reset.
     */
    loadProduct(product: BaseplateProduct): void {
      this.unitsX = product.unitsX;
      this.unitsY = product.unitsY;
      this.customSize = product.customXMm !== null || product.customYMm !== null;
      this.customXMm = product.customXMm ?? PITCH;
      this.customYMm = product.customYMm ?? PITCH;
      this.magnetMode = product.magnets !== null ? 'full' : 'none';
      this.magnetDiameterMm = product.magnets?.diameterMm ?? MAGNET_DIAMETER_DEFAULT;
      this.magnetHeightMm = product.magnets?.heightMm ?? MAGNET_HEIGHT_DEFAULT;
      this.screwHoleMode = product.screwHoles ? 'full' : 'none';
      this.connectable = product.connectable;
    },
  },
});
