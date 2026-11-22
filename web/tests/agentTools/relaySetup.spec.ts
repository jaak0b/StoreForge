import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RELAY_PACKAGE, RELAY_VERSION } from '../../src/agentTools/localRelay';
import { agentHostOsFromPlatform, relaySetupCommands } from '../../src/agentTools/relaySetup';

describe('relaySetupCommands', () => {
  it('registers the relay in Claude Code through cmd on Windows', () => {
    expect(relaySetupCommands('windows').claudeCode).toBe(
      'claude mcp add webmcp-relay -- cmd /c npx -y @mcp-b/webmcp-local-relay@6.2.0',
    );
  });

  it('registers the relay in Claude Code through npx directly on macOS and Linux', () => {
    expect(relaySetupCommands('unix').claudeCode).toBe(
      'claude mcp add webmcp-relay -- npx -y @mcp-b/webmcp-local-relay@6.2.0',
    );
  });

  it('gives a parseable mcpServers entry wrapping npx in cmd on Windows', () => {
    expect(JSON.parse(relaySetupCommands('windows').mcpServersJson)).toEqual({
      mcpServers: {
        'webmcp-relay': { command: 'cmd', args: ['/c', 'npx', '-y', '@mcp-b/webmcp-local-relay@6.2.0'] },
      },
    });
  });

  it('gives a parseable mcpServers entry running npx on macOS and Linux', () => {
    expect(JSON.parse(relaySetupCommands('unix').mcpServersJson)).toEqual({
      mcpServers: {
        'webmcp-relay': { command: 'npx', args: ['-y', '@mcp-b/webmcp-local-relay@6.2.0'] },
      },
    });
  });

  it('pretty-prints the mcpServers entry over several lines', () => {
    expect(relaySetupCommands('unix').mcpServersJson).toBe(`{
  "mcpServers": {
    "webmcp-relay": {
      "command": "npx",
      "args": [
        "-y",
        "@mcp-b/webmcp-local-relay@6.2.0"
      ]
    }
  }
}`);
  });
});

describe('relay version pin', () => {
  it('matches the exact version web/package.json installs', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { dependencies: Record<string, string> };

    expect(packageJson.dependencies[RELAY_PACKAGE]).toBe(RELAY_VERSION);
  });
});

describe('agentHostOsFromPlatform', () => {
  it.each([
    ['Win32', 'windows'],
    ['Windows', 'windows'],
    ['MacIntel', 'unix'],
    ['macOS', 'unix'],
    ['Linux x86_64', 'unix'],
    ['Linux', 'unix'],
    ['', 'windows'],
  ] as const)('maps the platform %j to %s', (platform, os) => {
    expect(agentHostOsFromPlatform(platform)).toBe(os);
  });
});
