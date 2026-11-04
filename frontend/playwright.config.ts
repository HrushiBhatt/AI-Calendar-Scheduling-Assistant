import { defineConfig } from '@playwright/test';

/**
 * Tests the site exactly as GitHub Pages serves it: static files under the repo's path. Deploys
 * wait on this, so a broken build can't replace the live site.
 *
 *   make e2e
 *
 * PAGES_URL points the same tests at the real site instead.
 */
const PORT = 5078;
const live = process.env['PAGES_URL'];
const base = process.env['PAGES_BASE'] ?? '/BrewFocus/';
const ci = !!process.env['CI'];

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  // CI machines are slower and busier. One retry stops a hiccup from holding up a deploy; a test
  // that needed it is still reported as flaky.
  retries: ci ? 1 : 0,
  reporter: ci ? 'github' : 'list',
  use: {
    baseURL: live ?? `http://127.0.0.1:${PORT}${base}`,
    timezoneId: 'America/New_York',
    locale: 'en-US',
    // Locally, drive the Chrome that's already installed; CI installs Playwright's Chromium.
    channel: ci ? undefined : 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: live
    ? undefined
    : {
        command: 'node e2e/serve.mjs',
        url: `http://127.0.0.1:${PORT}/health`,
        reuseExistingServer: false,
        env: { PAGES_PORT: String(PORT), PAGES_BASE: base },
      },
});
