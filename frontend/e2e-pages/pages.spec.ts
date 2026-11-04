import { Page, expect, test } from '@playwright/test';

/** Records everything that would mean the site is broken, or that it isn't really static. */
function watch(page: Page): { problems: string[]; apiCalls: string[] } {
  const problems: string[] = [];
  const apiCalls: string[] = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Pages answers a deep link with 404.html and a 404 status. That's how the app boots there,
    // and the browser logs it. A missing file has an extension, so it still counts.
    const deepLink = m.text().includes('404') && !/\.[a-z0-9]+$/i.test(new URL(m.location().url).pathname);
    if (!deepLink) problems.push(`console: ${m.text()} (${m.location().url})`);
  });
  page.on('requestfailed', (r) => problems.push(`failed: ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.request().isNavigationRequest()) problems.push(`${r.status()}: ${r.url()}`);
  });
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.includes('/api/')) apiCalls.push(r.url());
    if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) problems.push(`odd request: ${r.url()}`);
  });
  return { problems, apiCalls };
}

test('the page loads, shows the app, and needs no server', async ({ page }) => {
  const seen = watch(page);
  const photo = page.waitForResponse((r) => /alps-.*\.jpg$/.test(r.url()) && r.ok());
  const response = await page.goto('./');
  expect(response?.status()).toBe(200);
  await photo; // the background image, served from this site
  await expect(page.locator('.logo-text')).toHaveText('Brew Focus');
  await expect(page.locator('.demo-banner')).toContainText('runs entirely in your browser');
  await expect(page.getByRole('link', { name: 'Calendar', exact: true })).toBeVisible();
  await expect(page.locator('a.door')).toHaveCount(3);
  await page.locator('a.door', { hasText: 'Calendar' }).click();
  await expect(page.getByRole('tab', { name: 'Month' })).toBeVisible();
  // The sample account is there straight away, with no sign-in.
  await expect(page.getByText('Compiler project: register allocator')).toBeVisible();
  await expect(page.locator('.welcome')).toHaveCount(0); // not the login page
  await expect(page.locator('body')).toHaveCSS('font-family', /Outfit/);
  expect(seen.problems).toEqual([]);
  expect(seen.apiCalls).toEqual([]);
});

test('no page ever asks for a password', async ({ page }) => {
  await page.goto('login');
  await expect(page).toHaveURL(/AI-Calendar-Scheduling-Assistant\/$|\/$/);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Account' }).click();
  await expect(page.getByText('Reset the demo')).toBeVisible();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);
});

test('deep links and reloads work', async ({ page }) => {
  const response = await page.goto('progress');
  await expect(page.getByText('Consistency')).toBeVisible();
  expect(response?.ok() || response?.status() === 404).toBe(true); // Pages' 404.html boots the app
  await page.reload();
  await expect(page.getByText('Consistency')).toBeVisible();
  await page.getByRole('link', { name: 'Focus', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
});

test('the real scheduler plans around the sample meetings, in WebAssembly', async ({ page }) => {
  const seen = watch(page);
  await page.goto('calendar');

  // Google Calendar is shown but can't be used here, and the page says so.
  await expect(page.getByRole('button', { name: 'Connect Google Calendar' })).toBeDisabled();
  await expect(page.locator('app-calendar-card')).toContainText('Sample calendar');

  await page.locator('#plan-text').fill('plan three blocks next week');
  const wasm = page.waitForResponse((r) => r.url().endsWith('planner.wasm') && r.ok());
  await page.getByRole('button', { name: 'Plan it' }).click();
  await wasm;
  await expect(page).toHaveURL(/\/plan$/); // a command opens its own screen
  const review = page.locator('app-plan-review');
  await expect(review.locator('.blocks li')).toHaveCount(3);
  await expect(review).toContainText('phrase matcher'); // it says plainly that this isn't the AI model
  await expect(review.locator('.blocks li').first()).toContainText(/\d:\d\d/);

  // The scheduler's own reason, from its history term: only Go writes these sentences.
  await expect(review).toContainText(/you finish \d+% of blocks you start at this hour/);

  // Accept two of the three.
  await review.locator('.blocks li').nth(2).getByRole('checkbox').uncheck();
  await review.getByRole('button', { name: 'Accept 2' }).click();
  await expect(page.getByRole('status').filter({ hasText: '2 blocks scheduled' })).toBeVisible();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.locator('app-block-chip[data-status="accepted"]')).toHaveCount(2);

  // They survive a reload, on the day they were placed.
  const day = await page.locator('.view').getAttribute('data-day');
  await page.goto(`calendar?day=${day}`);
  await expect(page.locator('app-block-chip[data-status="accepted"]')).toHaveCount(2);
  expect(seen.problems).toEqual([]);
  expect(seen.apiCalls).toEqual([]);
});

test('the timer runs, pauses and survives a reload', async ({ page }) => {
  await page.goto('focus');
  await page.getByRole('button', { name: 'Start' }).click();
  const dialog = page.locator('app-intention-dialog');
  await dialog.locator('input').first().fill('Register allocator');
  const breathe = dialog.getByRole('checkbox');
  if (await breathe.isChecked()) await breathe.uncheck();
  await dialog.locator('.btn-primary').click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(page.getByText('Register allocator').first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible(); // still running
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
});

test('progress shows the sample history, and the demo can be reset', async ({ page }) => {
  await page.goto('progress');
  await expect(page.getByText('Consistency')).toBeVisible();
  await expect(page.getByText(/\d+ active days/)).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Account' }).click();
  await page.getByRole('button', { name: 'Reset the demo' }).click();
  await expect(page.locator('.logo-text')).toHaveText('Brew Focus');
});

test('light and dark mode follow the system, then the choice, across a reload', async ({ page }) => {
  const seen = watch(page);
  const html = page.locator('html');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('./');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(html).toHaveCSS('background-color', 'rgb(11, 19, 32)');

  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(html).toHaveCSS('background-color', 'rgb(219, 233, 246)');

  // A choice holds whatever the system does, and through a reload.
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.logo-text')).toHaveText('Brew Focus');

  // Settings offers following the system again.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'System' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  expect(seen.problems).toEqual([]);
});

test('the theme is set before the app loads, so a light page never flashes dark', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('brew:theme', '"light"'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.route('**/main-*.js', (route) => route.abort()); // no app at all, only the early script
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(219, 233, 246)');
});

test('an injected script is blocked by the page policy', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.logo-text')).toHaveText('Brew Focus');
  const ran = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__injected = true';
    document.body.append(script);
    return (window as unknown as { __injected?: boolean }).__injected ?? false;
  });
  expect(ran).toBe(false);
});
