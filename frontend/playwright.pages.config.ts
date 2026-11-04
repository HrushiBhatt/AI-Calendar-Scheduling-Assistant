import { defineConfig } from '@playwright/test';

/**
 * Tests the GitHub Pages demo exactly as Pages serves it: static files under the repo's path.
 * Deploys wait on this, so a broken build can't replace the live site.
 *
 *   make pages-build && cd frontend && npm run e2e:pages
 *
 * PAGES_URL points the same tests at the real site instead.
 */
const PORT = 5078;
const live = process.env['PAGES_URL'];
const base = process.env['PAGES_BASE'] ?? '/AI-Calendar-Scheduling-Assistant/';

export default defineConfig({
  testDir: './e2e-pages',
  timeout: 60_000,
  fullyParallel: false,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: live ?? `http://127.0.0.1:${PORT}${base}`,
    timezoneId: 'America/New_York',
    locale: 'en-US',
    // Locally, drive the Chrome that's already installed; CI installs Playwright's Chromium.
    channel: process.env['CI'] ? undefined : 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: live
    ? undefined
    : {
        command: 'node e2e-pages/serve.mjs',
        url: `http://127.0.0.1:${PORT}/health`,
        reuseExistingServer: false,
        env: { PAGES_PORT: String(PORT), PAGES_BASE: base },
      },
});
