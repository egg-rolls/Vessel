import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Usage plugin UI build (CONTRACT-0.45).
 *
 * Sources live in `web-src/`; the published iframe payload is `web/`. The
 * manifest keeps `ui.dir: web` and the three page entries unchanged, so the
 * host and its `/plugins/<id>/<entry>` static route need no changes.
 *
 * `base: './'` keeps the assets relative to the HTML file: an opaque-origin
 * sandboxed iframe has no useful origin to build absolute URLs from.
 */
const root = resolve(__dirname, 'web-src');
const pluginUiSrc = resolve(__dirname, '../../../packages/plugin-ui/src');

export default defineConfig({
  root,
  base: './',
  resolve: {
    // Same strategy as apps/web: consume the workspace package source
    // directly. `styles.css` must be matched before the package root.
    alias: [
      {
        find: '@vessel-agent/plugin-ui/styles.css',
        replacement: resolve(pluginUiSrc, 'styles.css'),
      },
      {
        find: /^@vessel-agent\/plugin-ui$/,
        replacement: resolve(pluginUiSrc, 'index.ts'),
      },
    ],
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, 'web'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        usage: resolve(root, 'usage.html'),
        logs: resolve(root, 'logs.html'),
        leaderboard: resolve(root, 'leaderboard.html'),
      },
    },
  },
});
