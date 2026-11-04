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

  // Connect the fake calendar through the real OAuth routes (state cookie and all).
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Connect a test calendar' }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(page.getByRole('status').filter({ hasText: 'Calendar connected' })).toBeVisible();

  // Ask in plain words; the stub turns it into a plan_focus_blocks call.
  await page.locator('#plan-text').fill('plan three blocks next week');
  await page.getByRole('button', { name: 'Plan it' }).click();
  const review = page.locator('app-plan-review');
  await expect(review.locator('.blocks li')).toHaveCount(3);
  await expect(review.getByText('Assistant’s note')).toBeVisible();

  // Leave the third out and accept the rest.
  await review.locator('.blocks li').nth(2).getByRole('checkbox').uncheck();
  await review.getByRole('button', { name: 'Accept 2' }).click();
  await expect(page.getByRole('status').filter({ hasText: '2 blocks scheduled' })).toBeVisible();

  const timeline = page.locator('app-day-timeline .timeline');
  await expect(page.locator('app-block-chip[data-status="accepted"]')).toHaveCount(2);
  const day = await timeline.getAttribute('data-day');
  expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // A second browser, same account: the server owns the plan, so it shows the same two.
  const other = await newPage(browser);
  await signIn(other, 'login');
  await other.goto(`/plan?day=${day}`);
  await expect(other.locator('app-block-chip[data-status="accepted"]')).toHaveCount(2);
  await expect(other.locator('app-block-chip[data-status="proposed"]')).toHaveCount(0);
});
