import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against the core sources so a stale dist can never mask a change.
    alias: { '@mates/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
