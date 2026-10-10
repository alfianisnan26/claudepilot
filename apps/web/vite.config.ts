import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { themeScript } from '@isnanme/ui';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Applies the stored theme before first paint (no flash when it differs from the system). */
const themeBeforePaint = (): Plugin => ({
  name: 'portal:theme-script',
  transformIndexHtml: () => [{ tag: 'script', children: themeScript(), injectTo: 'head-prepend' }],
});

// The dev server runs inside apps/server (one port for API + app); this config is shared.
export default defineConfig({
  plugins: [react(), tailwindcss(), themeBeforePaint()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true },
});
