/**
 * The agent-side setup text for the WebMCP local relay: the commands and the
 * MCP server entry that start the relay process next to a desktop agent, at
 * the same version as the browser files the app ships (see localRelay.ts).
 */

import { assertNever } from '../engine/plan/types';
import { RELAY_PACKAGE, RELAY_VERSION } from './localRelay';

/** The name the setup commands register the relay MCP server under. */
const RELAY_SERVER_NAME = 'webmcp-relay';

/** The operating system the agent runs on; Windows needs npx wrapped in cmd. */
export type AgentHostOs = 'windows' | 'unix';

/** The setup text for one operating system. */
export interface RelaySetupCommands {
  /** The Claude Code command that registers the relay. */
  claudeCode: string;
  /** The `mcpServers` JSON entry for agents configured by file (Claude Desktop, Cursor). */
  mcpServersJson: string;
}

/** The command and arguments that start the relay process on the given system. */
function relayLaunch(os: AgentHostOs): { command: string; args: string[] } {
  const npxArgs = ['-y', `${RELAY_PACKAGE}@${RELAY_VERSION}`];
  switch (os) {
    case 'windows':
      return { command: 'cmd', args: ['/c', 'npx', ...npxArgs] };
    case 'unix':
      return { command: 'npx', args: npxArgs };
    default:
      return assertNever(os);
  }
}

/** The relay setup command and JSON entry for the given operating system. */
export function relaySetupCommands(os: AgentHostOs): RelaySetupCommands {
  const { command, args } = relayLaunch(os);
  return {
    claudeCode: `claude mcp add ${RELAY_SERVER_NAME} -- ${[command, ...args].join(' ')}`,
    mcpServersJson: JSON.stringify({ mcpServers: { [RELAY_SERVER_NAME]: { command, args } } }, null, 2),
  };
}

/**
 * The operating system a browser platform string names (navigator.platform
 * or userAgentData.platform). Anything not recognized as macOS or Linux
 * falls back to Windows, the most common desktop system.
 */
export function agentHostOsFromPlatform(platform: string): AgentHostOs {
  return /mac|linux|x11|cros/i.test(platform) ? 'unix' : 'windows';
}
