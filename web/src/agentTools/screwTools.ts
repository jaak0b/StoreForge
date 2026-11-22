import type { Pinia } from 'pinia';
import { DEFAULT_MANUAL_DESIGN } from '../engine/plan/manualProduct';
import { describeProduct } from '../engine/plan/rowDescriptor';
import { parseShorthand } from '../engine/plan/screwListImport';
import {
  DEFAULT_SCREW_HEIGHT_UNITS,
  screwProducts,
  type ScrewBinSize,
} from '../engine/plan/screwProducts';
import { useBinQueue } from '../stores/binQueue';
import {
  ENTRY_PROPERTIES,
  productChoiceSchema,
  readProductChoice,
  SCREW_PRODUCT_CHOICES,
} from './binFields';
import { toolResult, type AgentTool } from './modelContext';
import {
  inputFields,
  optionalBoolean,
  optionalNumber,
  optionalObject,
  optionalString,
  requiredNumber,
  requiredString,
  runTool,
} from './toolInput';

/** The size override object, or null when the input leaves sizing automatic. */
function readSizeOverride(fields: Record<string, unknown>): ScrewBinSize | null {
  const size = optionalObject(fields, 'sizeOverride');
  if (size === undefined) return null;
  return { width: requiredNumber(size, 'width'), depth: requiredNumber(size, 'depth') };
}

export function addScrewsTool(pinia: Pinia): AgentTool {
  return {
    name: 'add_screws',
    title: 'Add screw bins',
    description:
      'Adds one sized, labeled bin (or label insert) per screw in a shorthand list, exactly as ' +
      'the Screw entry tab does. Each comma-separated entry names a thread (M3, #8, 1/4-20), a ' +
      'length in mm or inches, a head (fhcs, bhcs, shcs, hex, nut, washer, insert) and an ' +
      'optional quantity (x4), for example "m3x20 fhcs, m5x12 bhcs x4". Incomplete entries are ' +
      'skipped with a reason; the rest are added.',
    inputSchema: {
      type: 'object',
      properties: {
        list: {
          type: 'string',
          description: 'Screw shorthand, comma-separated, for example "m3x20 fhcs, m5 nut x10".',
        },
        productChoice: productChoiceSchema(
          SCREW_PRODUCT_CHOICES,
          `What to print for each screw. Default ${DEFAULT_MANUAL_DESIGN.productChoice}.`,
        ),
        heightUnits: {
          type: 'number',
          description: `Bin height in height units of 7 mm for a single screw. A list of several uses ${DEFAULT_SCREW_HEIGHT_UNITS}. Ignored for an insert, which has no height.`,
        },
        sizeOverride: {
          type: 'object',
          description:
            'Bin footprint for every screw, in grid units of 42 mm. Omit to size each bin from its screw.',
          properties: {
            width: { type: 'integer', description: 'Bin width in grid units of 42 mm.' },
            depth: { type: 'integer', description: 'Bin depth in grid units of 42 mm.' },
          },
          required: ['width', 'depth'],
        },
        magnetHoles: {
          type: 'boolean',
          description: `Whether the bin bases get magnet holes. Default ${DEFAULT_MANUAL_DESIGN.magnetHoles}.`,
        },
        notes: ENTRY_PROPERTIES.notes,
      },
      required: ['list'],
    },
    execute: (input) =>
      runTool(() => {
        const fields = inputFields(input);
        const parsed = parseShorthand(requiredString(fields, 'list'));
        const built = screwProducts(parsed.batches, {
          productChoice:
            readProductChoice(fields, SCREW_PRODUCT_CHOICES) ?? DEFAULT_MANUAL_DESIGN.productChoice,
          heightUnits: optionalNumber(fields, 'heightUnits') ?? DEFAULT_SCREW_HEIGHT_UNITS,
          sizeOverride: readSizeOverride(fields),
          magnetHoles: optionalBoolean(fields, 'magnetHoles') ?? DEFAULT_MANUAL_DESIGN.magnetHoles,
          fused: DEFAULT_MANUAL_DESIGN.fused,
          walls: [],
        });
        const report = {
          skipped: built.skipped.map((skip) => skip.reason),
          parseErrors: parsed.errors,
        };
        if (built.problem !== null) return toolResult({ problem: built.problem, ...report }, true);
        const result = useBinQueue(pinia).addMany(built.products, optionalString(fields, 'notes'));
        if (result.problem !== null) return toolResult({ problem: result.problem, ...report }, true);
        return toolResult({
          added: result.ids.map((id, index) => ({
            id,
            label: describeProduct(built.products[index].product).title,
            quantity: built.products[index].quantity,
          })),
          ...report,
        });
      }),
  };
}
