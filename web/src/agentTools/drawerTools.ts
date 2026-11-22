import type { Pinia } from 'pinia';
import {
  CLIP_TOLERANCE_DEFAULT,
  MAGNET_DIAMETER_DEFAULT,
  MAGNET_HEIGHT_DEFAULT,
} from '../engine/baseplate/constants';
import { groupDrawerFillPlanRows } from '../engine/baseplate/drawerFillPlan';
import {
  DRAWER_CONNECTABLE_DEFAULT,
  drawerPlateOptionsFromFields,
  HOLE_MODE_DEFAULT,
  HOLE_MODES,
} from '../engine/baseplate/plateOptions';
import { useBinQueue } from '../stores/binQueue';
import { toolResult, type AgentTool } from './modelContext';
import {
  inputFields,
  optionalBoolean,
  optionalChoice,
  optionalNumber,
  requiredNumber,
  requiredString,
  runTool,
} from './toolInput';

export function addDrawerBaseplatesTool(pinia: Pinia): AgentTool {
  return {
    name: 'add_drawer_baseplates',
    title: 'Fill a drawer with baseplates',
    description:
      'Plans Gridfinity baseplates that fill a drawer wall to wall, split into plates that fit ' +
      'the build plate, and queues them as one drawer group, exactly as the drawer fill panel ' +
      'does. All sizes are in mm. Leftover width becomes a brim on the outer plates. Returns ' +
      'the drawer id, its name and the plate split.',
    inputSchema: {
      type: 'object',
      properties: {
        drawerWidthMm: { type: 'number', description: 'Inner drawer width in mm.' },
        drawerDepthMm: { type: 'number', description: 'Inner drawer depth in mm.' },
        plateWidthMm: { type: 'number', description: 'Usable build plate width in mm.' },
        plateDepthMm: { type: 'number', description: 'Usable build plate depth in mm.' },
        magnetMode: {
          type: 'string',
          enum: [...HOLE_MODES],
          description: `Magnet holes in every cell (full) or none. Default ${HOLE_MODE_DEFAULT}.`,
        },
        magnetDiameterMm: {
          type: 'number',
          description: `Magnet hole diameter in mm when magnetMode is full. Default ${MAGNET_DIAMETER_DEFAULT}.`,
        },
        magnetHeightMm: {
          type: 'number',
          description: `Magnet hole depth in mm when magnetMode is full. Default ${MAGNET_HEIGHT_DEFAULT}.`,
        },
        screwHoleMode: {
          type: 'string',
          enum: [...HOLE_MODES],
          description: `Screw holes in every cell (full) or none. Default ${HOLE_MODE_DEFAULT}.`,
        },
        connectable: {
          type: 'boolean',
          description: `Whether the plates get connector slots and connection clips are queued. Default ${DRAWER_CONNECTABLE_DEFAULT}.`,
        },
        clipToleranceMm: {
          type: 'number',
          description: `Extra connection clip clearance in mm. Default ${CLIP_TOLERANCE_DEFAULT}.`,
        },
      },
      required: ['drawerWidthMm', 'drawerDepthMm', 'plateWidthMm', 'plateDepthMm'],
    },
    execute: (input) =>
      runTool(() => {
        const fields = inputFields(input);
        const queue = useBinQueue(pinia);
        const result = queue.addDrawerFromSize(
          {
            drawerWidthMm: requiredNumber(fields, 'drawerWidthMm'),
            drawerDepthMm: requiredNumber(fields, 'drawerDepthMm'),
            plateWidthMm: requiredNumber(fields, 'plateWidthMm'),
            plateDepthMm: requiredNumber(fields, 'plateDepthMm'),
          },
          drawerPlateOptionsFromFields({
            magnetMode: optionalChoice(fields, 'magnetMode', HOLE_MODES) ?? HOLE_MODE_DEFAULT,
            magnetDiameterMm: optionalNumber(fields, 'magnetDiameterMm') ?? MAGNET_DIAMETER_DEFAULT,
            magnetHeightMm: optionalNumber(fields, 'magnetHeightMm') ?? MAGNET_HEIGHT_DEFAULT,
            screwHoleMode: optionalChoice(fields, 'screwHoleMode', HOLE_MODES) ?? HOLE_MODE_DEFAULT,
            connectable: optionalBoolean(fields, 'connectable') ?? DRAWER_CONNECTABLE_DEFAULT,
          }),
          optionalNumber(fields, 'clipToleranceMm'),
        );
        if (result.problem !== null) return toolResult({ problem: result.problem }, true);
        const group = queue.groupById(result.groupId)!;
        return toolResult({
          id: group.id,
          name: group.name,
          plates: groupDrawerFillPlanRows(group.payload.plates).map((row) => ({
            count: row.count,
            gridUnits: row.unitsLabel,
            outerSizeMm: row.outerLabel,
            brimMm: row.brimLabel,
          })),
          connectionClips: group.payload.clips?.count ?? 0,
        });
      }),
  };
}

export function removeDrawerTool(pinia: Pinia): AgentTool {
  return {
    name: 'remove_drawer',
    title: 'Remove a drawer',
    description:
      'Removes a drawer baseplate group and every still-queued plate and connection clip row ' +
      'that belongs to it. Plates already on a build plate stay there. Get drawer ids from ' +
      'list_queue.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The drawer id, from list_queue.' } },
      required: ['id'],
    },
    annotations: { consequentialHint: true },
    execute: (input) =>
      runTool(() => {
        const id = requiredString(inputFields(input), 'id');
        const problem = useBinQueue(pinia).removeGroup(id);
        if (problem !== null) return toolResult({ problem }, true);
        return toolResult({ removed: id });
      }),
  };
}
