import type { Pinia } from 'pinia';
import { addBinTool, updateEntryTool } from './binTools';
import { addDrawerBaseplatesTool, removeDrawerTool } from './drawerTools';
import { duplicateEntryTool, removeEntryTool } from './entryTools';
import { listIconsTool, listQueueTool } from './listTools';
import { realmNeutralCopy, type AgentTool, type ModelContextLike } from './modelContext';
import { addScrewsTool } from './screwTools';

export interface AgentToolDeps {
  /** Where the tools register: `document.modelContext`, or a fake in tests. */
  modelContext: ModelContextLike;
  /** The app's Pinia instance, whose stores the tools act through. */
  pinia: Pinia;
}

/** Every agent tool, in the order an agent would typically discover them. */
export function agentTools(pinia: Pinia): AgentTool[] {
  return [
    listQueueTool(pinia),
    listIconsTool(pinia),
    addBinTool(pinia),
    addScrewsTool(pinia),
    addDrawerBaseplatesTool(pinia),
    updateEntryTool(pinia),
    duplicateEntryTool(pinia),
    removeEntryTool(pinia),
    removeDrawerTool(pinia),
  ];
}

/**
 * A tool as it is handed to the model context: its schema and annotations
 * replaced by realm-neutral copies (see realmNeutralCopy), so the WebMCP local
 * relay widget's iframe realm accepts them as plain objects.
 */
function registrationOf(tool: AgentTool): AgentTool {
  const registered: AgentTool = { ...tool, inputSchema: realmNeutralCopy(tool.inputSchema) };
  if (tool.annotations !== undefined) registered.annotations = realmNeutralCopy(tool.annotations);
  return registered;
}

/**
 * Registers every agent tool on the model context. WebMCP has no unregister:
 * aborting the returned controller withdraws them all. A registration the
 * context refuses is reported on the console with the tool's name; the other
 * tools stay registered.
 */
export function registerAgentTools(deps: AgentToolDeps): AbortController {
  const controller = new AbortController();
  for (const tool of agentTools(deps.pinia)) {
    deps.modelContext
      .registerTool(registrationOf(tool), { signal: controller.signal })
      .catch((error: unknown) => {
        // Withdrawing the tools on purpose rejects their registrations with the
        // abort reason; that is the requested outcome, not a failure.
        if (controller.signal.aborted) return;
        console.error(`Registering the agent tool ${tool.name} failed.`, error);
      });
  }
  return controller;
}
