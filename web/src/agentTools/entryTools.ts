import type { Pinia } from 'pinia';
import { describeProduct } from '../engine/plan/rowDescriptor';
import { drawerGroupIdOf } from '../engine/plan/types';
import { useBinQueue } from '../stores/binQueue';
import { toolResult, type AgentTool } from './modelContext';
import { inputFields, requiredString, runTool } from './toolInput';

const ENTRY_ID_SCHEMA = {
  type: 'object' as const,
  properties: { id: { type: 'string', description: 'The queue entry id, from list_queue.' } },
  required: ['id'],
};

export function duplicateEntryTool(pinia: Pinia): AgentTool {
  return {
    name: 'duplicate_entry',
    title: 'Duplicate a queue entry',
    description:
      'Adds a copy of a queue entry with the same product, quantity and notes, and returns the ' +
      'new entry id. A drawer plate or clip row is copied as a standalone entry outside the ' +
      'drawer. Get ids from list_queue.',
    inputSchema: ENTRY_ID_SCHEMA,
    execute: (input) =>
      runTool(() => {
        const queue = useBinQueue(pinia);
        const result = queue.duplicate(requiredString(inputFields(input), 'id'));
        if (result.problem !== null) return toolResult({ problem: result.problem }, true);
        return toolResult({
          id: result.id,
          title: describeProduct(queue.entryById(result.id)!.product).title,
        });
      }),
  };
}

export function removeEntryTool(pinia: Pinia): AgentTool {
  return {
    name: 'remove_entry',
    title: 'Remove a queue entry',
    description:
      'Removes one entry from the print queue by id. Rows that belong to a drawer are removed ' +
      'with remove_drawer instead. Get ids from list_queue.',
    inputSchema: ENTRY_ID_SCHEMA,
    annotations: { consequentialHint: true },
    execute: (input) =>
      runTool(() => {
        const queue = useBinQueue(pinia);
        const id = requiredString(inputFields(input), 'id');
        const entry = queue.entryById(id);
        if (entry !== null && drawerGroupIdOf(entry.product) !== null) {
          return toolResult(
            {
              problem:
                'This entry belongs to a drawer, whose plan sets its plates and clips. Remove the whole drawer with remove_drawer.',
            },
            true,
          );
        }
        const problem = queue.remove(id);
        if (problem !== null) return toolResult({ problem }, true);
        return toolResult({ removed: id });
      }),
  };
}
