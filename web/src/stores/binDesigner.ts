import { defineStore } from 'pinia';
import type { InsertContentParams, SlottedBinParams } from '../engine/gridfinity/types';
import type { LabelContent } from '../engine/plan/types';

/**
 * What a designer form produces: a bin plus its matching label insert, a
 * bin with an empty slot, a plain bin without the slot, or a standalone
 * insert for a bin that already exists. Maps onto the plan layer's Product
 * kinds ('bin' and 'plainBin' both save as the bin product, with labelSlot
 * true and false); the tab that saves the entry adds its own origin.
 */
export type ProductChoice = 'binWithInsert' | 'bin' | 'plainBin' | 'insert';

/**
 * Parameters of the product currently being designed, plus notes (not part
 * of the geometry, but shared across the Manual bin and Screw entry tabs'
 * More options disclosure so the value persists across tab switches). For an
 * insert-only design, gridX doubles as the insert's width in cells; the
 * other bin fields are simply unused.
 */
export const useBinDesigner = defineStore('binDesigner', {
  state: () => ({
    productChoice: 'binWithInsert' as ProductChoice,
    gridX: 1,
    gridY: 1,
    heightUnits: 6,
    magnetHoles: false,
    dividerCountX: 0,
    dividerCountY: 0,
    labelText: '',
    labelText2: '',
    labelIcon: null as string | null,
    /**
     * Whether a Bin + label insert product prints as one fused piece (label
     * raised on the bin, no swappable insert slot). Only meaningful when the
     * product choice is binWithInsert.
     */
    fused: false,
    notes: '',
    moreOptionsOpen: false,
  }),
  getters: {
    /** Whether the chosen product carries a label: the single source for label-field visibility. */
    hasLabel(state): boolean {
      return state.productChoice === 'binWithInsert' || state.productChoice === 'insert';
    },
    /** The designed label content. */
    content(state): LabelContent {
      return {
        text: state.labelText,
        text2: state.labelText2,
        icon: state.labelIcon,
      };
    },
    /**
     * The geometry parameters of the designed bin, with the insert content
     * riding along for the preview when the product includes the insert.
     */
    binParams(state): SlottedBinParams {
      const content: InsertContentParams = {
        text: state.labelText,
        text2: state.labelText2,
        icon: state.labelIcon,
      };
      const withInsert = state.productChoice === 'binWithInsert';
      const fused = withInsert && state.fused;
      return {
        gridX: state.gridX,
        gridY: state.gridY,
        heightUnits: state.heightUnits,
        magnetHoles: state.magnetHoles,
        dividerCountX: state.dividerCountX,
        dividerCountY: state.dividerCountY,
        // A fused bin has no insert channel; the label is raised on the solid
        // fused shelf the body builder puts in the channel's place.
        labelSlot: state.productChoice !== 'plainBin' && !fused,
        insert: withInsert && !fused ? content : null,
        fusedLabel: fused ? content : null,
      };
    },
  },
});
