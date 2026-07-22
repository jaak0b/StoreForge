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
 * How the divider walls are being edited in the form. This is editing state
 * only, never persisted: the plan format stores the wall list, and the mode is
 * inferred from it on load (no walls means None, walls present means Custom;
 * Grid is never inferred, since a regular grid and a hand edit that happens to
 * be regular are indistinguishable once stored). None keeps the wall list
 * empty; Grid keeps it generated from the two counts; Custom leaves it under
 * the free-angle editor.
 */
export type DividerMode = 'none' | 'grid' | 'custom';

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
     * Which divider editing mode the form shows. Editing state only, not part
     * of the plan (see DividerMode). Defaults to None so a fresh design starts
     * with no dividers and the most compact form.
     */
    dividerMode: 'none' as DividerMode,
    /**
     * The grid mode's two divider counts: countX walls across the width and
     * countY across the depth. Only meaningful in Grid mode, where a change to
     * either regenerates the wall list immediately.
     */
    dividerCountX: 0,
    dividerCountY: 0,
    /**
     * Whether interactive divider edits are attracted to the quarter pitch
     * lattice, the bin interior, the other walls and 15 degree directions. A
     * global editor setting rather than a property of any wall: it constrains
     * how an edit is applied and leaves nothing behind on the wall it
     * produced. On by default, since clean layouts are the common case; the
     * attraction is magnetic, so free positions and free angles stay reachable
     * without turning it off.
     */
    snapEnabled: true,
    /**
     * How far in mm an edit may be from a target and still be attracted to it.
     * The canvas owns the figure and republishes it whenever a gesture starts,
     * converting its fixed pixel pull radius through the view scale in force.
     * Zero until a view has reported a scale, which attracts nothing: no view
     * means no screen-space affordance to honour.
     */
    snapToleranceMm: 0,
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
      return { enabled: this.snapEnabled, toleranceMm: this.snapToleranceMm };
    },
    /** Publishes the pull radius the canvas derived from its current scale. */
    setSnapToleranceMm(toleranceMm: number): void {
      this.snapToleranceMm = toleranceMm;
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
     * The even-dividers generator: generates evenly spaced walls and replaces
     * the list with them. A generator, never a second representation, so the
     * walls it produced stay freely editable afterwards. The single
     * counts-to-walls path both the grid mode and the grid-to-custom seed use.
     */
    applyEvenDividers(countX: number, countY: number): void {
      this.walls = divider.evenDividerWalls(this.gridX, this.gridY, countX, countY);
      this.selectedWallIndex = null;
    },
    /**
     * Regenerates the grid walls from the current counts and bin footprint.
     * Grid mode is declarative: the wall list always reflects the current
     * counts and the current bin size, so both a count change and a footprint
     * change route here. A footprint that is not yet a valid bin (empty or
     * mid-edit field) leaves the walls untouched until it parses, rather than
     * writing a wall list against a nonsense interior.
     */
    applyGridDividers(): void {
      if (
        !Number.isFinite(this.gridX) ||
        !Number.isFinite(this.gridY) ||
        this.gridX < 1 ||
        this.gridY < 1
      ) {
        return;
      }
      this.applyEvenDividers(this.dividerCountX, this.dividerCountY);
    },
    /** Sets the bin width in cells, regenerating the grid walls while in grid
     * mode so they track the footprint. */
    setGridX(value: number): void {
      this.gridX = value;
      if (this.dividerMode === 'grid') this.applyGridDividers();
    },
    /** Sets the bin depth in cells, regenerating the grid walls while in grid
     * mode so they track the footprint. */
    setGridY(value: number): void {
      this.gridY = value;
      if (this.dividerMode === 'grid') this.applyGridDividers();
    },
    /**
     * Switches the divider editing mode, taking the wall list with it: None
     * empties it, Grid regenerates it from the counts, and Custom keeps
     * whatever is there (the grid it was just showing, or loaded walls) so the
     * free editor picks up from the current shape.
     */
    setDividerMode(mode: DividerMode): void {
      this.dividerMode = mode;
      if (mode === 'none') {
        this.walls = [];
        this.selectedWallIndex = null;
      } else if (mode === 'grid') {
        this.applyGridDividers();
      }
    },
    /** Sets a grid divider count (clamped to a non-negative integer), applying
     * it immediately while in grid mode. */
    setDividerCount(axis: 'x' | 'y', value: number): void {
      const count = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
      if (axis === 'x') this.dividerCountX = count;
      else this.dividerCountY = count;
      if (this.dividerMode === 'grid') this.applyGridDividers();
    },
    /**
     * Infers the editing mode from the loaded wall list: walls present opens
     * the free editor (Custom), none opens with dividers off (None). Grid is
     * never inferred, since the plan does not record that a wall list was
     * generated. Called after an entry's walls are loaded into the form.
     */
    inferDividerModeFromWalls(): void {
      this.dividerMode = this.walls.length > 0 ? 'custom' : 'none';
      this.dividerCountX = 0;
      this.dividerCountY = 0;
    },
  },
});
