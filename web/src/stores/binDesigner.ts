import { defineStore } from 'pinia';
import type { InsertContentParams, SlottedBinParams } from '../engine/gridfinity/types';
import { evenDividerWalls } from '../engine/gridfinity/dividerModel';
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
      const insert: InsertContentParams | null =
        state.productChoice === 'binWithInsert'
          ? { text: state.labelText, text2: state.labelText2, icon: state.labelIcon }
          : null;
      return {
        gridX: state.gridX,
        gridY: state.gridY,
        heightUnits: state.heightUnits,
        magnetHoles: state.magnetHoles,
        // The store keeps the two count fields as its editing representation
        // (the More options UI is unchanged); the free divider walls the
        // geometry layer consumes are derived from the counts here. Temporary
        // until the Stage 2 canvas editor edits walls directly.
        walls: evenDividerWalls(
          state.gridX,
          state.gridY,
          state.dividerCountX,
          state.dividerCountY,
        ),
        labelSlot: state.productChoice !== 'plainBin',
        insert,
      };
    },
  },
});
