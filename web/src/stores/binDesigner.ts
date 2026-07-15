import { defineStore } from 'pinia';
import type { LabeledBinParams } from '../engine/gridfinity/types';

/** Parameters of the bin currently being designed. */
export const useBinDesigner = defineStore('binDesigner', {
  state: (): LabeledBinParams => ({
    gridX: 1,
    gridY: 1,
    heightUnits: 3,
    stackingLip: true,
    magnetHoles: false,
    labelText: '',
    labelIcon: null,
  }),
  getters: {
    params(state): LabeledBinParams {
      return {
        gridX: state.gridX,
        gridY: state.gridY,
        heightUnits: state.heightUnits,
        stackingLip: state.stackingLip,
        magnetHoles: state.magnetHoles,
        labelText: state.labelText,
        labelIcon: state.labelIcon,
      };
    },
  },
});
