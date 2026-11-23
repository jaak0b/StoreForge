import type { Pinia } from 'pinia';
import { useCustomIcons } from '../stores/customIcons';
import { toolResult, type AgentTool } from './modelContext';
import { InputProblem, inputFields, requiredObjectList, requiredString, runTool } from './toolInput';

/** One icon of an add_custom_icons call, read before anything is added. */
interface IconRequest {
  name: string;
  svg: string;
}

/**
 * The icons of the input, every one read up front so a malformed item refuses
 * the whole call before any icon is added. The problem names the item.
 */
function readIconRequests(fields: Record<string, unknown>): IconRequest[] {
  return requiredObjectList(fields, 'icons').map((item, index) => {
    try {
      return { name: requiredString(item, 'name'), svg: requiredString(item, 'svg') };
    } catch (error) {
      if (error instanceof InputProblem) {
        throw new InputProblem(`In icons item ${index + 1}: ${error.message}`);
      }
      throw error;
    }
  });
}

export function addCustomIconsTool(pinia: Pinia): AgentTool {
  return {
    name: 'add_custom_icons',
    title: 'Add custom label icons',
    description:
      "Adds icons to the user's custom label icons, exactly as the Add a custom icon dialog does. " +
      'Each icon takes a name and its SVG as markup, bare path data, or an http(s) link to an ' +
      '.svg file. Icons are added in order; each result says whether it was added or why it was ' +
      'refused (invalid shape, or a name already used by any icon). Added names work as ' +
      'labelIcon in add_bin and update_entry.',
    inputSchema: {
      type: 'object',
      properties: {
        icons: {
          type: 'array',
          description: 'The icons to add, in order.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The new icon name. It must not match any existing icon.' },
              svg: {
                type: 'string',
                description: 'SVG markup, bare SVG path data, or an http(s) link to an .svg file.',
              },
            },
            required: ['name', 'svg'],
          },
        },
      },
      required: ['icons'],
    },
    annotations: { untrustedContentHint: true },
    execute: (input) =>
      runTool(async () => {
        const requests = readIconRequests(inputFields(input));
        const icons = useCustomIcons(pinia);
        const results: Record<string, unknown>[] = [];
        // Sequential on purpose: an icon added earlier in the call takes its
        // name, so a later item with the same name is refused like any clash.
        for (const request of requests) {
          const result = await icons.importIcon(request.name, request.svg);
          results.push(
            result.ok
              ? { name: request.name.trim(), added: true }
              : { name: request.name, added: false, problem: result.error },
          );
        }
        return toolResult({ results });
      }),
  };
}

export function removeCustomIconTool(pinia: Pinia): AgentTool {
  return {
    name: 'remove_custom_icon',
    title: 'Remove a custom label icon',
    description:
      "Removes one of the user's custom label icons by name, exactly as the icon picker's remove " +
      'button does. Queued bins that use it keep the name and print without an icon. Built-in ' +
      'icons cannot be removed. Get names from list_icons.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The custom icon name, from list_icons.' },
      },
      required: ['name'],
    },
    annotations: { consequentialHint: true },
    execute: (input) =>
      runTool(() => {
        const name = requiredString(inputFields(input), 'name');
        const problem = useCustomIcons(pinia).removeByName(name);
        if (problem !== null) return toolResult({ problem }, true);
        return toolResult({ removed: name });
      }),
  };
}
