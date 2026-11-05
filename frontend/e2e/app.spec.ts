import { Browser, Page, expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// A new address each time: the server's database lasts for the whole run, and test workers run
// side by side, so a timestamp alone can repeat.
const newEmail = () => `e2e-${randomUUID()}@example.com`;
const password = 'correct horse battery';

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

async function signUp(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('tab', { name: 'Sign up' }).click();
  await page.locator('input[type=email]').fill(newEmail());
  await page.locator('input[type=password]').fill(password);
  await page.locator('form .btn-primary').click();
  await expect(page).toHaveURL(/\/$/);
}

test('add a task, run a focus block on it, and see it on the progress page', async ({ browser }) => {
  const page = await newPage(browser);
  await signUp(page);

  // A task to work on.
  await page.getByPlaceholder('New task…').fill('Write the report');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Write the report')).toBeVisible();

  // Start a focus block: intention first, then the timer runs on the server.
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const intention = page.locator('app-intention-dialog');
  await intention.locator('input').first().fill('First draft');
  const breathe = intention.getByRole('checkbox');
  if (await breathe.isChecked()) await breathe.uncheck();
  await intention.locator('.btn-primary').click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(page.locator('.intention')).toContainText('First draft');

  // It's the server's timer, so a reload picks it up where it was.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();

  // Pause and resume, then cancel: under a minute, so nothing is logged.
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();

  // The progress page opens, with its heatmap and café.
  await page.getByRole('link', { name: 'Progress' }).click();
  await expect(page).toHaveURL(/\/progress$/);
  await expect(page.locator('app-heatmap svg')).toBeVisible();
  await expect(page.locator('app-cafe-shelf')).toBeVisible();
});

test('without an account, every page leads to sign-in and the API refuses', async ({ browser }) => {
  const page = await newPage(browser);
  for (const path of ['/', '/progress', '/settings', '/nowhere']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('.welcome')).toBeVisible();
    await expect(page.locator('app-timer-stage')).toHaveCount(0);
  }
  for (const path of ['/api/me', '/api/tasks', '/api/timer', '/api/stats']) {
    expect((await page.request.get(path)).status(), path).toBe(401);
  }
  // The removed integrations are really gone, not just hidden.
  for (const path of ['/api/schedule', '/api/insights', '/api/calendar/accounts', '/api/plans/live']) {
    expect((await page.request.get(path)).status(), path).toBe(404);
  }
  expect((await page.request.post('/api/assistant/plan', { data: {} })).status()).toBe(404);
});

test('the page runs under its security policy, and signing out ends the session', async ({ browser }) => {
  const page = await newPage(browser);
  const violations: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  const offsite: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1') && !/^(data|blob):/.test(r.url())) offsite.push(r.url());
  });
  const response = await page.goto('/login');
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  expect(response?.headers()['x-frame-options']).toBe('DENY');

  // Styles and the self-hosted fonts really apply under the policy.
  await expect(page.locator('.title')).toHaveCSS('font-family', /Press Start 2P/);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('12px "Press Start 2P"'))).toBe(true);

  // An injected inline script is blocked by the browser itself.
  expect(
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.__injected = true';
      document.body.append(script);
      return (window as unknown as { __injected?: boolean }).__injected ?? false;
    }),
  ).toBe(false);
  // That script, reported once per policy: the server's header and the page's meta tag. Nothing else.
  expect(violations.length).toBe(2);
  violations.length = 0;

  // Sign up. The JWT is in a cookie page scripts can't read, so injected code can't steal it.
  await signUp(page);
  await expect(page.locator('app-timer-stage')).toBeVisible();
  const session = (await page.context().cookies()).find((c) => c.name === 'bf_session');
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Lax');
  expect(await page.evaluate(() => document.cookie)).not.toContain('bf_session');

  // Sign out.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // The old session is over: the API refuses, and the app stays on the login page.
  expect((await page.request.get('/api/me')).status()).toBe(401);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  expect(violations).toEqual([]);
  expect(offsite).toEqual([]);
});

test('the content uses the whole width of the page', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 2200, height: 1000 } });
  const page = await context.newPage();
  await signUp(page);
  for (const [path, selector] of [['/', 'app-brew-page'], ['/progress', 'app-progress-page']]) {
    await page.goto(path);
    const box = await page.locator(selector).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(2200 * 0.9);
    expect(box!.x).toBeCloseTo(2200 - (box!.x + box!.width), 0); // the same margin each side
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});
