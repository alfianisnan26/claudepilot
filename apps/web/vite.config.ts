import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { themeScript } from '@isnanme/ui';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Applies the stored theme before first paint (no flash when it differs from the system). Not on the reporter panel (embed.html):
 * it follows the system theme and carries no inline script, so its CSP needs no hash.
 */
const themeBeforePaint = (): Plugin => ({
  name: 'portal:theme-script',
  transformIndexHtml: (_html, ctx) => (ctx.filename.endsWith('embed.html') ? [] : [{ tag: 'script', children: themeScript(), injectTo: 'head-prepend' }]),
});

// The dev server runs inside apps/server (one port for API + app); this config is shared.
export default defineConfig({
  plugins: [react(), tailwindcss(), themeBeforePaint()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // Two pages: the app (dist/index.html) and the reporter panel (dist/embed.html, served by the server at /reporter/v1/embed;
      // docs/prd/ui-reporter.md). The panel imports neither the app shell nor the router, so it loads only React and its own code.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        embed: fileURLToPath(new URL('./embed.html', import.meta.url)),
      },
      output: {
        // T-376 S4: one 1.27 MB entry script is one 240 ms task at 4x CPU. The big libraries are their own scripts, each evaluated in its own
        // task (and cached across deploys while the library does not change).
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined;
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          if (/\/node_modules\/(motion|motion-dom|motion-utils|framer-motion)\//.test(id)) return 'motion';
          if (/\/node_modules\/(react-router|lucide-react)\//.test(id)) return 'router-icons';
          return undefined;
        },
      },
    },
  },
});
