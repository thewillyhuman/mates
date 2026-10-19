import { defineConfig } from '@playwright/test';

/**
 * Browser tests (§15.2 M6). globalSetup starts Postgres (testcontainers or
 * MATES_TEST_DATABASE_URL) and mates-api in fake-jobs mode serving the built
 * UI; tests talk to that server and seed runs through the API.
 */
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.MATES_E2E_URL ?? 'http://127.0.0.1:18180',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
