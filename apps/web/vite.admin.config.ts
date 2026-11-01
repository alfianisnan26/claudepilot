import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The Admin console (docs/prd/organizations.md §6.11): its own small bundle, built apart from the app into dist-admin and served by the server
 * under /admin-ui/ on the admin host ONLY. Nothing of the main app (its shell, router, service worker, public files) is in it, and the main
 * build (vite.config.ts) does not contain it. It follows the system theme and carries no inline script, so its CSP needs no hash.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  base: '/admin-ui/',
  publicDir: false,
  build: {
    outDir: 'dist-admin',
    emptyOutDir: true,
    rollupOptions: {
      input: { admin: fileURLToPath(new URL('./admin.html', import.meta.url)) },
    },
  },
});
