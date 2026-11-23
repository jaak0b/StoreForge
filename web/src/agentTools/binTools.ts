import type { Pinia } from 'pinia';
import {
  choiceHasLabel,
  DEFAULT_MANUAL_DESIGN,
  designChoiceOf,
  manualDesignOf,
  manualProduct,
  PRODUCT_CHOICES,
  type ManualDesign,
} from '../engine/plan/manualProduct';
import { describeProduct } from '../engine/plan/rowDescriptor';
import { composeShorthand, parseShorthand } from '../engine/plan/screwListImport';
import {
  DEFAULT_SCREW_HEIGHT_UNITS,
  screwBinSizeOf,
  screwProducts,
} from '../engine/plan/screwProducts';
import {
  assertNever,
  binOf,
  drawerGroupIdOf,
  originOf,
  screwOf,
  type Product,
  type QueueEntry,
  type QueueEntryUpdate,
} from '../engine/plan/types';
import { UNKNOWN_ENTRY_PROBLEM, useBinQueue } from '../stores/binQueue';
import {
  BIN_SIZE_PROPERTIES,
  ENTRY_PROPERTIES,
  LABEL_PROPERTIES,
  labelFieldsGiven,
  productChoiceSchema,
  readBinSize,
  readLabelContent,
  readProductChoice,
  SCREW_PRODUCT_CHOICES,
} from './binFields';
import { toolResult, type AgentTool, type ToolResult } from './modelContext';
import {
  InputProblem,
  inputFields,
  optionalNumber,
  optionalString,
  requiredString,
  runTool,
} from './toolInput';

const NO_LABEL_PROBLEM =
  'This product has no label insert, so it takes no label text or icon. Choose binWithInsert or insert to print a label.';

const SCREW_LABEL_PROBLEM =
  'The label of a screw entry is composed from its screw description and cannot be set directly. Queue the screw again with add_screws to change it.';

/**
 * A manual design with the input's fields applied over a base design, built
 * into its product by the designer's own mapping. Label fields on a choice
 * without a label are refused, as the designer form hides them for it.
 */
function designedProduct(fields: Record<string, unknown>, base: ManualDesign): Product {
  const productChoice = readProductChoice(fields, PRODUCT_CHOICES) ?? base.productChoice;
  if (!choiceHasLabel(productChoice) && labelFieldsGiven(fields)) {
    throw new InputProblem(NO_LABEL_PROBLEM);
  }
  const size = readBinSize(fields);
  return manualProduct({
    productChoice,
    gridX: size.gridX ?? base.gridX,
    gridY: size.gridY ?? base.gridY,
    heightUnits: size.heightUnits ?? base.heightUnits,
    magnetHoles: size.magnetHoles ?? base.magnetHoles,
    walls: base.walls,
    content: readLabelContent(fields, base.content),
    fused: base.fused,
  });
}

export function addBinTool(pinia: Pinia): AgentTool {
  return {
    name: 'add_bin',
    title: 'Add a bin',
    description:
      'Adds one hand-designed Gridfinity bin, bin with label insert, or standalone label insert ' +
      'to the print queue, exactly as the Manual bin tab does. Sizes are in grid units of 42 mm ' +
      'and height units of 7 mm; omitted fields take the designer defaults. Use add_screws for ' +
      'screw and fastener bins. A custom label icon can be added first with add_custom_icons. ' +
      'Returns the new entry id.',
    inputSchema: {
      type: 'object',
      properties: {
        productChoice: productChoiceSchema(
          PRODUCT_CHOICES,
          `What to print. Default ${DEFAULT_MANUAL_DESIGN.productChoice}.`,
        ),
        ...BIN_SIZE_PROPERTIES,
        ...LABEL_PROPERTIES,
        ...ENTRY_PROPERTIES,
      },
    },
    execute: (input) =>
      runTool(() => {
        const fields = inputFields(input);
        const product = designedProduct(fields, DEFAULT_MANUAL_DESIGN);
        const result = useBinQueue(pinia).add(
          product,
          optionalNumber(fields, 'quantity'),
          optionalString(fields, 'notes'),
        );
        if (result.problem !== null) return toolResult({ problem: result.problem }, true);
        return toolResult({ id: result.id, title: describeProduct(product).title });
      }),
  };
}

/**
 * A screw entry rebuilt through the Screw entry tab's own edit path: the
 * stored screw becomes shorthand again, is parsed, and screwProducts builds it
 * with the stored size (or the input's) as the size override, keeping the
 * walls, the fused flag and the imperial length text.
 */
function updatedScrewProduct(entry: QueueEntry, fields: Record<string, unknown>): Product {
  const product = entry.product;
  const screw = screwOf(product);
  if (screw === null) throw new Error('A screw entry must carry its screw description.');
  if (labelFieldsGiven(fields)) throw new InputProblem(SCREW_LABEL_PROBLEM);
  const choice = designChoiceOf(product);
  const bin = binOf(product);
  const screwBin = bin !== null && bin.origin === 'screw' ? bin : null;
  const stored = screwBinSizeOf(product);
  const size = readBinSize(fields);
  const parsed = parseShorthand(
    composeShorthand(screw.thread, screw.lengthMm, screw.head, entry.quantity),
  );
  const built = screwProducts(parsed.batches, {
    productChoice: readProductChoice(fields, SCREW_PRODUCT_CHOICES) ?? choice.productChoice,
    heightUnits: size.heightUnits ?? screwBin?.heightUnits ?? DEFAULT_SCREW_HEIGHT_UNITS,
    sizeOverride: { width: size.gridX ?? stored.width, depth: size.gridY ?? stored.depth },
    magnetHoles: size.magnetHoles ?? screwBin?.magnetHoles ?? DEFAULT_MANUAL_DESIGN.magnetHoles,
    fused: choice.fused,
    walls: screwBin?.walls ?? [],
    keepEnteredLengthFrom: screw,
  });
  if (built.problem !== null) throw new InputProblem(built.problem);
  if (built.products.length !== 1) {
    throw new Error('A stored screw description must rebuild to exactly one product.');
  }
  return built.products[0].product;
}

/**
 * The product an update writes, rebuilt by the flow that created the entry, or
 * the user-worded reason the agent cannot edit an entry of this origin.
 */
function updatedProduct(
  entry: QueueEntry,
  fields: Record<string, unknown>,
): { product: Product; refusal: null } | { product: null; refusal: string } {
  const origin = originOf(entry.product);
  switch (origin) {
    case 'manual': {
      const design = manualDesignOf(entry.product);
      if (design === null) throw new Error('A manual entry must load as a manual design.');
      return { product: designedProduct(fields, design), refusal: null };
    }
    case 'screw':
      return { product: updatedScrewProduct(entry, fields), refusal: null };
    case 'traced':
      return {
        product: null,
        refusal:
          'This entry is a traced tool bin. Its pockets are edited in the Tool trace tab; the agent can only edit manual and screw entries.',
      };
    case 'cutout':
      return {
        product: null,
        refusal:
          'This entry is an STL cutout bin. Its models are edited in the Cutout tab; the agent can only edit manual and screw entries.',
      };
    case 'baseplate':
    case 'clip':
      return {
        product: null,
        refusal:
          drawerGroupIdOf(entry.product) !== null
          ? 'This entry belongs to a drawer, whose plan sets its plates and clips. Remove the drawer with remove_drawer and add it again with add_drawer_baseplates to change it.'
            : 'This entry is a baseplate or connection clip. It is edited in the Baseplate tab; the agent can only edit manual and screw entries.',
      };
    default:
      return assertNever(origin);
  }
}

export function updateEntryTool(pinia: Pinia): AgentTool {
  return {
    name: 'update_entry',
    title: 'Update a queue entry',
    description:
      'Changes a manual or screw queue entry by id: quantity, notes, size (grid units of 42 mm, ' +
      'height units of 7 mm), magnet holes, product choice, or label. Omitted fields keep their ' +
      'current value. A screw entry keeps its screw description and composed label. Traced, ' +
      'cutout, baseplate and drawer entries cannot be edited here. Get ids from list_queue.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The queue entry id, from list_queue.' },
        productChoice: productChoiceSchema(
          PRODUCT_CHOICES,
          'What to print. A screw entry accepts only binWithInsert or insert.',
        ),
        ...BIN_SIZE_PROPERTIES,
        ...LABEL_PROPERTIES,
        ...ENTRY_PROPERTIES,
      },
      required: ['id'],
    },
    execute: (input) =>
      runTool((): ToolResult => {
        const fields = inputFields(input);
        const queue = useBinQueue(pinia);
        const entry = queue.entryById(requiredString(fields, 'id'));
        if (entry === null) return toolResult({ problem: UNKNOWN_ENTRY_PROBLEM }, true);
        const rebuilt = updatedProduct(entry, fields);
        if (rebuilt.refusal !== null) return toolResult({ problem: rebuilt.refusal }, true);
        const changes: QueueEntryUpdate = { product: rebuilt.product };
        const quantity = optionalNumber(fields, 'quantity');
        if (quantity !== undefined) changes.quantity = quantity;
        const notes = optionalString(fields, 'notes');
        if (notes !== undefined) changes.notes = notes;
        const problem = queue.update(entry.id, changes);
        if (problem !== null) return toolResult({ problem }, true);
        const updated = queue.entryById(entry.id)!;
        return toolResult({ id: updated.id, title: describeProduct(updated.product).title });
      }),
  };
}
