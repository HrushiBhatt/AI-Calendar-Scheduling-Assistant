import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests of the app against the real Go server. Run with `npm run e2e`, which
 * builds the app first.
 */
const PORT = 5077;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    timezoneId: 'America/New_York',
    locale: 'en-US',
    // Locally, drive the Chrome that's already installed; CI installs Playwright's Chromium.
    channel: process.env['CI'] ? undefined : 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'go run ./cmd/server -static ../frontend/dist/brew-focus/browser',
    cwd: '../backend',
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ADDR: `127.0.0.1:${PORT}`,
      DB_PATH: ':memory:',
      GIN_MODE: 'release',
      JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret',
    },
  },
});
