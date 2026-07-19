import { defineStore } from 'pinia';
import type { InsertContentParams, SlottedBinParams } from '../engine/gridfinity/types';
import * as divider from '../engine/gridfinity/dividerModel';
import type { DividerWall } from '../engine/gridfinity/dividerModel';
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
    /**
     * The divider walls being edited: the editing representation itself, not
     * a projection of anything else. The canvas editor mutates these through
     * the actions below, and the even-dividers quick entry replaces the whole
     * list, so there is no second store of divider state.
     */
    walls: [] as DividerWall[],
    /** Index of the wall the canvas editor has selected, or null for none. */
    selectedWallIndex: null as number | null,
    /**
     * Whether interactive divider edits snap to the quarter pitch lattice and
     * to 15 degree directions. A global editor setting rather than a property
     * of any wall: it constrains how an edit is applied and leaves nothing
     * behind on the wall it produced. On by default, since clean layouts are
     * the common case and free angles are the deliberate exception.
     */
    snapEnabled: true,
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
        // Detached plain objects: the walls travel to the geometry worker by
        // structured clone, which cannot clone the store's reactive proxies.
        walls: state.walls.map((wall) => ({ ...wall })),
        // A fused bin has no insert channel; the label is raised on the solid
        // fused shelf the body builder puts in the channel's place.
        labelSlot: state.productChoice !== 'plainBin' && !fused,
        insert: withInsert && !fused ? content : null,
        fusedLabel: fused ? content : null,
      };
    },
    /** The selected wall, or null when nothing is selected. */
    selectedWall(state): DividerWall | null {
      if (state.selectedWallIndex === null) return null;
      return state.walls[state.selectedWallIndex] ?? null;
    },
  },
  // Thin one-to-one wrappers over engine/gridfinity/dividerModel, which is the
  // single home for divider wall logic; the only thing added here is which
  // wall the editor has selected, a view concern the model does not carry.
  actions: {
    selectWall(index: number | null): void {
      this.selectedWallIndex =
        index !== null && index >= 0 && index < this.walls.length ? index : null;
    },
    /** The current snapping settings, as the divider model takes them. */
    snapOptions(): divider.SnapOptions {
      return { enabled: this.snapEnabled };
    },
    /** Adds a wall, selects it, and returns its index. */
    addWall(wall?: DividerWall): number {
      // A wall placed by the toolbar already sits on a generated position, so
      // only a wall drawn on the canvas is worth snapping.
      divider.addWall(
        this,
        wall ?? divider.nextDefaultWall(this),
        wall === undefined ? divider.SNAP_OFF : this.snapOptions(),
      );
      this.selectedWallIndex = this.walls.length - 1;
      return this.selectedWallIndex;
    },
    deleteWall(index: number): void {
      divider.deleteWall(this, index);
      this.selectWall(this.selectedWallIndex);
    },
    duplicateWall(index: number): void {
      if (divider.duplicateWall(this, index) === null) return;
      this.selectedWallIndex = this.walls.length - 1;
    },
    /**
     * Translates a wall. During a drag the caller passes the wall as it stood
     * at the start of the gesture together with the total delta since, so a
     * snapped drag accumulates instead of rounding every increment away.
     */
    moveWall(
      index: number,
      dxMm: number,
      dyMm: number,
      origin?: DividerWall,
    ): void {
      divider.moveWall(this, index, dxMm, dyMm, this.snapOptions(), origin);
    },
    moveWallEndpoint(index: number, endpoint: 1 | 2, xMm: number, yMm: number): void {
      divider.moveWallEndpoint(this, index, endpoint, xMm, yMm, this.snapOptions());
    },
    /** Exact numeric entry, which is deliberate and so never snapped. */
    setWall(index: number, wall: DividerWall): void {
      divider.setWall(this, index, wall);
    },
    /**
     * The even-dividers quick entry: generates evenly spaced walls and
     * replaces the list with them. A generator, never a second representation,
     * so the walls it produced stay freely editable afterwards.
     */
    applyEvenDividers(countX: number, countY: number): void {
      this.walls = divider.evenDividerWalls(this.gridX, this.gridY, countX, countY);
      this.selectedWallIndex = null;
    },
  },
});
