import { resolveLabelIcon } from '../labelIcons';
import { DEFAULT_ENTRY_QUANTITY } from '../stores/binQueue';
import {
  BIN_ALONE_CHOICES,
  DEFAULT_MANUAL_DESIGN,
  PRODUCT_CHOICES,
  type ProductChoice,
  type ProductChoiceInfo,
} from '../engine/plan/manualProduct';
import type { LabelContent } from '../engine/plan/types';
import type { JsonSchema } from './modelContext';
import {
  InputProblem,
  optionalBoolean,
  optionalChoice,
  optionalNullableString,
  optionalNumber,
  optionalString,
} from './toolInput';

/**
 * The bin and label fields add_bin, add_screws and update_entry share: their
 * schemas (defaults quoted from the shared constants, choice descriptions from
 * the product picker's own list) and their readers.
 */

/** The product choices a screw entry offers: every choice except a bin alone. */
export const SCREW_PRODUCT_CHOICES: readonly ProductChoiceInfo[] = PRODUCT_CHOICES.filter(
  (choice) => !BIN_ALONE_CHOICES.includes(choice.value),
);

/** A productChoice schema over the given choices, each described as the picker describes it. */
export function productChoiceSchema(
  choices: readonly ProductChoiceInfo[],
  description: string,
): JsonSchema {
  return {
    type: 'string',
    description,
    enum: choices.map((choice) => choice.value),
    oneOf: choices.map((choice) => ({
      const: choice.value,
      title: choice.title,
      description: choice.subtitle,
    })),
  };
}

/** Reads productChoice against the given choices, or undefined when absent. */
export function readProductChoice(
  fields: Record<string, unknown>,
  choices: readonly ProductChoiceInfo[],
): ProductChoice | undefined {
  return optionalChoice(
    fields,
    'productChoice',
    choices.map((choice) => choice.value),
  );
}

export const BIN_SIZE_PROPERTIES: Record<string, JsonSchema> = {
  gridX: {
    type: 'integer',
    description: `Bin width in grid units of 42 mm; for an insert only, its width in cells. Default ${DEFAULT_MANUAL_DESIGN.gridX}.`,
  },
  gridY: {
    type: 'integer',
    description: `Bin depth in grid units of 42 mm. Default ${DEFAULT_MANUAL_DESIGN.gridY}.`,
  },
  heightUnits: {
    type: 'number',
    description: `Bin height in height units of 7 mm. Default ${DEFAULT_MANUAL_DESIGN.heightUnits}.`,
  },
  magnetHoles: {
    type: 'boolean',
    description: `Whether the bin base gets magnet holes. Default ${DEFAULT_MANUAL_DESIGN.magnetHoles}.`,
  },
};

export const LABEL_PROPERTIES: Record<string, JsonSchema> = {
  labelText: {
    type: 'string',
    description: 'First label line. Only for a product with a label insert.',
  },
  labelText2: {
    type: 'string',
    description: 'Second, smaller label line. Only for a product with a label insert.',
  },
  labelIcon: {
    type: ['string', 'null'],
    description: 'Label icon name from list_icons, or null for no icon.',
  },
};

export const ENTRY_PROPERTIES: Record<string, JsonSchema> = {
  quantity: { type: 'integer', description: `How many copies to print. Default ${DEFAULT_ENTRY_QUANTITY}.` },
  notes: { type: 'string', description: 'Free-form notes on the queue entry.' },
};

/** Whether the input sets any label field. */
export function labelFieldsGiven(fields: Record<string, unknown>): boolean {
  return Object.keys(LABEL_PROPERTIES).some((key) => fields[key] !== undefined);
}

/**
 * The label content with the given label fields applied over a base. An icon
 * is resolved through the UI's own icon resolver, so an unknown name is
 * refused rather than queued.
 */
export function readLabelContent(
  fields: Record<string, unknown>,
  base: LabelContent,
): LabelContent {
  const icon = optionalNullableString(fields, 'labelIcon');
  if (icon !== undefined && icon !== null && resolveLabelIcon(icon) === null) {
    throw new InputProblem(
      `There is no label icon named "${icon}". Call list_icons for the available icon names.`,
    );
  }
  return {
    text: optionalString(fields, 'labelText') ?? base.text,
    text2: optionalString(fields, 'labelText2') ?? base.text2,
    icon: icon === undefined ? base.icon : icon,
  };
}

/** The bin size fields, each undefined when absent. */
export function readBinSize(fields: Record<string, unknown>): {
  gridX: number | undefined;
  gridY: number | undefined;
  heightUnits: number | undefined;
  magnetHoles: boolean | undefined;
} {
  return {
    gridX: optionalNumber(fields, 'gridX'),
    gridY: optionalNumber(fields, 'gridY'),
    heightUnits: optionalNumber(fields, 'heightUnits'),
    magnetHoles: optionalBoolean(fields, 'magnetHoles'),
  };
}
