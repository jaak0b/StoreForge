import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { RELAY_DIRECTORY, RELAY_FILES } from './src/agentTools/localRelay';

/**
 * Ships the WebMCP local relay's browser files (embed script and the widget it
 * loads) from the installed @mcp-b/webmcp-local-relay package: emitted into
 * the build output under RELAY_DIRECTORY, and served from the same path by the
 * dev server. The embed script resolves widget.html relative to its own URL,
 * so all three files share one directory on the app's own origin.
 */
function webmcpRelayAssets(): Plugin {
  const packageEntry = createRequire(import.meta.url).resolve('@mcp-b/webmcp-local-relay');
  const sourceDir = join(dirname(packageEntry), 'browser');
  const read = (name: string): Buffer => readFileSync(join(sourceDir, name));
  const contentType = (name: string): string =>
    name.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8';
  return {
    name: 'webmcp-relay-assets',
    configureServer(server) {
      server.middlewares.use(`/${RELAY_DIRECTORY}/`, (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\//, '');
        const file = RELAY_FILES.find((candidate) => candidate === name);
        if (file === undefined) {
          next();
          return;
        }
        res.setHeader('Content-Type', contentType(file));
        res.end(read(file));
      });
    },
    generateBundle() {
      for (const file of RELAY_FILES) {
        this.emitFile({ type: 'asset', fileName: `${RELAY_DIRECTORY}/${file}`, source: read(file) });
      }
    },
  };
}

// base './' keeps asset URLs relative, so the built site works both at a
// domain root and under a GitHub Pages project sub-path.
export default defineConfig({
  base: './',
  plugins: [vue(), webmcpRelayAssets()],
  worker: {
    format: 'es',
  },
});
