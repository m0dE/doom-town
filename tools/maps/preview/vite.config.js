// Standalone build of the map preview (tools/maps/preview): serves public/ (base pak and
// public/maps/*.wad) next to it. npx vite build -c tools/maps/preview/vite.config.js
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
export default defineConfig({
  root: here,
  base: './',
  publicDir: join(root, 'public'),
  define: { __BUILD_REV__: JSON.stringify('preview') },
  build: { outDir: join(root, 'tools/maps/out/preview'), emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4000 },
  preview: { port: 5194 },
});
