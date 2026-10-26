import { defineConfig } from '@playwright/test';

/**
 * One end-to-end test of the planning loop against the real Go server, with the two
 * outside services swapped for in-process doubles: CALENDAR_PROVIDER=fake (an in-memory
 * calendar behind our own OAuth routes) and ASSISTANT_PROVIDER=stub (a phrase-matching
 * stand-in for the model). Run with `npm run e2e`, which builds the app first.
 */
const PORT = 5077;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
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
      CALENDAR_ENC_KEY: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      CALENDAR_PROVIDER: 'fake',
      ASSISTANT_PROVIDER: 'stub',
    },
  },
});
