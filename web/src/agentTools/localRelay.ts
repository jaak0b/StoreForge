/**
 * Loading the WebMCP local relay (@mcp-b/webmcp-local-relay): its embed script
 * opens a hidden iframe that connects to a relay process on this computer
 * (ws://127.0.0.1:9333) and relays the page's `document.modelContext` tools to
 * a desktop agent. The build ships the package's browser files under
 * RELAY_DIRECTORY next to the app (see vite.config.ts), because the embed
 * script resolves widget.html relative to its own URL.
 *
 * The embed script has no teardown: it injects its iframe after an
 * asynchronous fetch and asks the widget to reconnect whenever the tab becomes
 * visible again. Once loaded, the relay therefore stays connected until the
 * page is reloaded.
 */

/** The relay's npm package: its browser files ship with the app, its CLI runs beside the agent. */
export const RELAY_PACKAGE = '@mcp-b/webmcp-local-relay';

/**
 * The relay version, pinned exactly in package.json. The agent side must run
 * the same version as the shipped browser files, so the setup commands pin it.
 */
export const RELAY_VERSION = '6.2.0';

/** The directory the relay's browser files are served from, relative to the app base. */
export const RELAY_DIRECTORY = 'webmcp-relay';

/** The relay's browser files, all served from RELAY_DIRECTORY. */
export const RELAY_FILES = ['embed.js', 'widget.html', 'widget.js'] as const;

/** The attribute marking the embed script element this app inserted. */
const SCRIPT_MARKER = 'data-storeforge-relay';

/** The slice of a script element the loader sets. */
export interface RelayScriptElement {
  src: string;
  setAttribute(name: string, value: string): void;
  addEventListener(type: 'error', listener: () => void): void;
}

/**
 * The slice of `document` the loader touches; tests pass a fake. Generic over
 * the script element type because the DOM's appendChild only takes nodes.
 */
export interface RelayDocument<Script extends RelayScriptElement> {
  querySelector(selector: string): unknown;
  createElement(tagName: 'script'): Script;
  head: { appendChild(node: Script): unknown };
}

/**
 * The absolute URL of the relay embed script. The app base is relative ('./')
 * because the site is served from a GitHub Pages sub-path, so it is resolved
 * against the document base, never against the origin root.
 */
export function relayScriptUrl(appBase: string, documentBase: string): string {
  return new URL(`${appBase}${RELAY_DIRECTORY}/embed.js`, documentBase).href;
}

/**
 * Inserts the relay embed script once per page. Returns true when this call
 * inserted it, false when it was already present. A failed script load is
 * reported on the console with its URL.
 */
export function loadLocalRelay<Script extends RelayScriptElement>(
  doc: RelayDocument<Script>,
  scriptUrl: string,
): boolean {
  if (doc.querySelector(`script[${SCRIPT_MARKER}]`) !== null) return false;
  const script = doc.createElement('script');
  script.setAttribute(SCRIPT_MARKER, '');
  script.addEventListener('error', () => {
    console.error(`The WebMCP local relay script could not be loaded from ${scriptUrl}.`);
  });
  script.src = scriptUrl;
  doc.head.appendChild(script);
  return true;
}
