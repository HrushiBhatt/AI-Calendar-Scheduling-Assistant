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
  const response = await page.goto('./');
  expect(response?.status()).toBe(200);
  await expect(page.locator('.logo-text')).toHaveText('Brew Focus');
  await expect(page.locator('.demo-banner')).toContainText('runs entirely in your browser');
  await expect(page.getByRole('link', { name: 'Progress' })).toBeVisible();
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
  await expect(page.getByText('Reset the demo')).toBeVisible();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);
});

test('deep links and reloads work', async ({ page }) => {
  const response = await page.goto('progress');
  await expect(page.locator('app-heatmap svg')).toBeVisible();
  expect(response?.ok() || response?.status() === 404).toBe(true); // Pages' 404.html boots the app
  await page.reload();
  await expect(page.locator('app-heatmap svg')).toBeVisible();
});

test('the timer runs, pauses and survives a reload', async ({ page }) => {
  const seen = watch(page);
  await page.goto('./');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const intention = page.locator('app-intention-dialog');
  await intention.locator('input').first().fill('Demo block');
  const breathe = intention.getByRole('checkbox');
  if (await breathe.isChecked()) await breathe.uncheck();
  await intention.locator('.btn-primary').click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.intention')).toContainText('Demo block');
  await page.getByRole('button', { name: 'Reset' }).click();
  expect(seen.problems).toEqual([]);
});

test('tasks can be added, finished and removed', async ({ page }) => {
  await page.goto('./');
  await page.getByPlaceholder('New task…').fill('Buy coffee beans');
  await page.getByRole('button', { name: 'Add' }).click();
  const task = page.locator('app-task-list li', { hasText: 'Buy coffee beans' });
  await expect(task).toBeVisible();
  await task.getByRole('checkbox').check();
  await expect(task.getByRole('checkbox')).toBeChecked();
  await page.reload();

  // It was saved, and now sits in the folded list of finished tasks.
  await page.locator('app-task-list details summary').click();
  const finished = page.locator('app-task-list li', { hasText: 'Buy coffee beans' });
  await expect(finished).toBeVisible();
  await finished.getByRole('button', { name: /delete/i }).click();
  await expect(finished).toHaveCount(0);
});

test('progress shows the sample history, and the demo can be reset', async ({ page }) => {
  await page.goto('progress');
  await expect(page.locator('app-heatmap svg')).toBeVisible();
  await expect(page.getByText(/\d+ active days/)).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Reset the demo' }).click();
  await expect(page.locator('.logo-text')).toHaveText('Brew Focus');
});

test('it starts dark, and a switch to light holds across a reload', async ({ page }) => {
  const seen = watch(page);
  const html = page.locator('html');
  await page.emulateMedia({ colorScheme: 'light' }); // the system's preference doesn't decide
  await page.goto('./');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(html).toHaveCSS('color-scheme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)');

  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(247, 241, 232)');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  expect(seen.problems).toEqual([]);
});

test('the theme is set before the app loads, so a light page never flashes dark', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('brew:theme', '"light"'));
  await page.route('**/main-*.js', (route) => route.abort()); // no app at all, only the early script
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(247, 241, 232)');
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

test('the content uses the whole width of the page, evenly on both sides', async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 1000 });
  for (const [path, selector] of [['./', 'app-brew-page'], ['progress', 'app-progress-page']]) {
    await page.goto(path);
    const box = await page.locator(selector).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(2200 * 0.9);
    expect(box!.x).toBeCloseTo(2200 - (box!.x + box!.width), 0);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});
