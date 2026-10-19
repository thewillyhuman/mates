import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * The UI is served by mates-api from the same origin (§3.1), so the build
 * lands in the API package's public dir and dev mode proxies /api to it.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Dev server and tests use the core sources; the production build uses the built package.
    alias:
      process.env.NODE_ENV === 'production'
        ? {}
        : { '@mates/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
  build: {
    outDir: '../api/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/webhooks': 'http://localhost:8080',
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
});
