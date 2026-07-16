import { defineStore } from 'pinia';
import type { LabeledBinParams } from '../engine/gridfinity/types';

/** Parameters of the bin currently being designed, plus notes (not part of
 * the bin geometry, but shared across the Manual bin and Screw entry tabs'
 * More options disclosure so the value persists across tab switches). */
export const useBinDesigner = defineStore('binDesigner', {
  state: (): LabeledBinParams & { notes: string } => ({
    gridX: 1,
    gridY: 1,
    heightUnits: 3,
    stackingLip: true,
    magnetHoles: false,
    dividerCountX: 0,
    dividerCountY: 0,
    labelText: '',
    labelText2: '',
    labelIcon: null,
    notes: '',
  }),
  getters: {
    params(state): LabeledBinParams {
      return {
        gridX: state.gridX,
        gridY: state.gridY,
        heightUnits: state.heightUnits,
        stackingLip: state.stackingLip,
        magnetHoles: state.magnetHoles,
        dividerCountX: state.dividerCountX,
        dividerCountY: state.dividerCountY,
        labelText: state.labelText,
        labelText2: state.labelText2,
        labelIcon: state.labelIcon,
      };
    },
  },
});
