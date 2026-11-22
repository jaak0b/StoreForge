import { describe, expect, it } from 'vitest';
import {
  loadLocalRelay,
  relayScriptUrl,
  type RelayDocument,
  type RelayScriptElement,
} from '../../src/agentTools/localRelay';

type FakeScript = RelayScriptElement & { attributes: Map<string, string> };

/** A document that keeps the script elements appended to its head and answers the loader's selector. */
function fakeDocument(): RelayDocument<FakeScript> & { scripts: FakeScript[] } {
  const scripts: FakeScript[] = [];
  return {
    scripts,
    querySelector(selector: string) {
      const attribute = /^script\[(.+)\]$/.exec(selector)?.[1];
      return scripts.find((script) => attribute !== undefined && script.attributes.has(attribute)) ?? null;
    },
    createElement(): FakeScript {
      const attributes = new Map<string, string>();
      return {
        src: '',
        setAttribute: (name: string, value: string) => void attributes.set(name, value),
        addEventListener: () => {},
        attributes,
      };
    },
    head: {
      appendChild(node: FakeScript) {
        scripts.push(node);
        return node;
      },
    },
  };
}

describe('relayScriptUrl', () => {
  it('resolves the relative app base against a GitHub Pages sub-path', () => {
    expect(relayScriptUrl('./', 'https://example.github.io/StoreForge/')).toBe(
      'https://example.github.io/StoreForge/webmcp-relay/embed.js',
    );
  });

  it('resolves the relative app base against a page with a file name', () => {
    expect(relayScriptUrl('./', 'https://example.github.io/StoreForge/index.html')).toBe(
      'https://example.github.io/StoreForge/webmcp-relay/embed.js',
    );
  });

  it('resolves the dev server root base against the origin', () => {
    expect(relayScriptUrl('/', 'http://localhost:5173/')).toBe(
      'http://localhost:5173/webmcp-relay/embed.js',
    );
  });
});

describe('loadLocalRelay', () => {
  it('inserts one script with the given URL', () => {
    const doc = fakeDocument();

    const inserted = loadLocalRelay(doc, 'https://example.github.io/StoreForge/webmcp-relay/embed.js');

    expect(inserted).toBe(true);
    expect(doc.scripts.map((script) => script.src)).toEqual([
      'https://example.github.io/StoreForge/webmcp-relay/embed.js',
    ]);
  });

  it('inserts nothing more when the relay is already loaded', () => {
    const doc = fakeDocument();
    loadLocalRelay(doc, 'https://example.github.io/StoreForge/webmcp-relay/embed.js');

    const inserted = loadLocalRelay(doc, 'https://example.github.io/StoreForge/webmcp-relay/embed.js');

    expect(inserted).toBe(false);
    expect(doc.scripts).toHaveLength(1);
  });
});
