import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The web UI is a small SPA served by the daemon via `sirv` from `web/dist`.
export default defineConfig({
  root: 'web',
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
