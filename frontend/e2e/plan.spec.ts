import { Browser, Page, expect, test } from '@playwright/test';

const email = `e2e-${Date.now()}@example.com`;
const password = 'correct horse battery';

async function signIn(page: Page, mode: 'register' | 'login'): Promise<void> {
  await page.goto('/login');
  if (mode === 'register') await page.getByRole('tab', { name: 'Sign up' }).click();
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.locator('form .btn-primary').click();
  await expect(page).toHaveURL(/\/$/);
}

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

test('plan, accept two of three, and see them everywhere', async ({ browser }) => {
  const page = await newPage(browser);
  await signIn(page, 'register');

  // Signing in lands on the home page, with a door to each tab.
  await expect(page.locator('a.door')).toHaveCount(3);
  await page.locator('a.door', { hasText: 'Calendar' }).click();
  await expect(page).toHaveURL(/\/calendar$/);

  // The calendar offers to connect one. The fake one goes through the real OAuth routes
  // (state cookie and all), then the offer goes away.
  await page.locator('app-calendar-card').getByRole('button', { name: 'Connect a test calendar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Calendar connected' })).toBeVisible();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.locator('app-calendar-card section')).toHaveCount(0);

  // Ask in plain words; the stub turns it into a plan_focus_blocks call.
  await page.locator('#plan-text').fill('plan three blocks next week');
  await page.getByRole('button', { name: 'Plan with Claude' }).click();
  await expect(page).toHaveURL(/\/plan$/); // a command opens its own screen
  const review = page.locator('app-plan-review');
  await expect(review.locator('.blocks li')).toHaveCount(3);
  await expect(review.locator('.narration')).toContainText('Claude');

  // Leave the third out and accept the rest.
  await review.locator('.blocks li').nth(2).getByRole('checkbox').uncheck();
  await review.getByRole('button', { name: 'Accept 2' }).click();
  await expect(page.getByRole('status').filter({ hasText: '2 blocks scheduled' })).toBeVisible();
  await expect(page).toHaveURL(/\/calendar$/); // and accepting returns to the calendar

  await expect(page.locator('app-block-chip[data-status="accepted"]')).toHaveCount(2);
  const day = await page.locator('.view').getAttribute('data-day');
  expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // The three views show the same two blocks.
  await page.getByRole('tab', { name: 'Month' }).click();
  await expect(page.locator('.item[data-kind="focus"]')).toHaveCount(2);
  await page.locator(`.cell[data-day="${day}"]`).click();
  await expect(page.getByRole('tab', { name: 'Day' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('app-block-chip[data-status="accepted"]')).not.toHaveCount(0);
  await page.getByRole('tab', { name: 'Week' }).click();
  await expect(page.locator('app-block-chip[data-status="accepted"]')).toHaveCount(2);

  // A planned block opens its details, and can be moved to another day by keyboard.
  const chip = page.locator('app-block-chip[data-status="accepted"]').first();
  await chip.click();
  await expect(page.locator('app-block-card')).toBeVisible();
  await expect(page.locator('app-block-card').getByRole('button', { name: 'Start' })).toBeVisible();
  await page.locator('app-block-card').getByRole('button', { name: 'Close' }).click();
  const column = () => chip.evaluate((el) => el.closest<HTMLElement>('.col')!.dataset['day']);
  const id = await chip.getAttribute('data-id');
  const moved = page.locator(`app-block-chip[data-id="${id}"]`);
  const dayBefore = await column();
  await moved.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => moved.evaluate((el) => el.closest<HTMLElement>('.col')!.dataset['day'])).not.toBe(dayBefore);

  // And by dragging, an hour down its new day.
  const before = await moved.getAttribute('aria-label');
  const box = (await moved.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 72, { steps: 6 });
  await page.mouse.up();
  await expect(moved).not.toHaveAttribute('aria-label', before!);

  // A second browser, same account: the server owns the plan, so it shows the same two.
  const other = await newPage(browser);
  await signIn(other, 'login');
  await other.goto(`/calendar?day=${day}`);
  await expect(other.locator('app-block-chip[data-status="accepted"]')).toHaveCount(2);
  await expect(other.locator('app-block-chip[data-status="proposed"]')).toHaveCount(0);
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

  // This server has no Google keys: the button still shows, and says what's missing.
  const google = page.getByRole('button', { name: 'Sign in with Google' });
  await expect(google).toBeDisabled();
  await expect(google.locator('svg')).toBeVisible();
  await expect(page.getByText('Add the Google keys to .env')).toBeVisible();

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
  expect(violations.length).toBe(1); // that one script, and nothing the app itself does
  violations.length = 0;

  // A new password that's easy to guess is refused, with the server's reason.
  await page.getByRole('tab', { name: 'Sign up' }).click();
  const owner = `session-${Date.now()}@example.com`;
  await page.locator('input[type=email]').fill(owner);
  await page.locator('input[type=password]').fill('password1234');
  await page.locator('form .btn-primary').click();
  await expect(page.locator('.form-error')).toContainText('too easy to guess');
  await page.locator('input[type=password]').fill(password);
  await page.locator('form .btn-primary').click();
  await expect(page).toHaveURL(/\/$/);

  // The session cookie can't be read by page scripts.
  expect(await page.evaluate(() => document.cookie)).not.toContain('bf_session');

  // A thief copies the cookie, then the owner signs out: the copy stops working.
  const context = page.context();
  const thief = await browser.newContext();
  await thief.addCookies((await context.cookies()).filter((c) => c.name === 'bf_session'));
  expect((await thief.request.get('/api/me')).status()).toBe(200);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Account' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await thief.request.get('/api/me')).status()).toBe(401);

  expect(violations).toEqual([]);
  expect(offsite).toEqual([]); // no third party learns who visits: not even a font server
});
