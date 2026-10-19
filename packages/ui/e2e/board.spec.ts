import { expect, test, type Page } from '@playwright/test';
import { ADMIN, adminContext, configure, play, startOnly, trigger } from './seed.js';

/** Board (§13.1): stats strip, needs-a-human lane, columns, live updates over SSE. */
async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('board shows seeded runs in their columns and the needs-a-human lane', async ({
  page,
  baseURL,
}) => {
  const api = await adminContext(baseURL!);
  await configure(api);
  // A finished run, a blocked run (clarification) and a live one.
  const done = await trigger(api, 'INFRA-73');
  await play(api, done.id, 'intake_implementable');
  await play(api, done.id, 'impl_iter1_green');
  await play(api, done.id, 'review_approve');
  const blocked = await trigger(api, 'PLAT-412');
  await play(api, blocked.id, 'intake_needs_clarification');
  const live = await trigger(api, 'API-198');
  await play(api, live.id, 'intake_implementable');
  await startOnly(api, live.id);

  await login(page);
  await expect(page.getByTestId('header-counters')).toContainText('1 running');
  await expect(page.getByTestId('header-counters')).toContainText('1 need you');
  await expect(page.getByRole('region', { name: 'Needs a human' })).toContainText(
    'Clarification requested',
  );
  await expect(page.getByRole('region', { name: 'Needs a human' })).toContainText(
    'Which applies to the free tier?',
  );
  const implementing = page.getByRole('region', { name: 'Implementing' });
  await expect(implementing.getByTestId('run-card')).toHaveCount(1);
  await expect(implementing).toContainText('API-198');
  // No SCM token in this environment: the done run has no MR and is listed as ready this week.
  await expect(page.locator('.footer-merged')).toContainText('INFRA-73');
  await expect(page.getByRole('region', { name: 'Blocked' })).toContainText('PLAT-412');
  await expect(page.locator('.stats-strip')).toContainText('MRs opened today');
  await page.screenshot({ path: 'e2e/screenshots/board.png', fullPage: true });

  // Live update: finishing the implementer moves the card to "In review" without a reload.
  await play(api, live.id, 'impl_iter1_green');
  await expect(page.getByRole('region', { name: 'In review' })).toContainText('API-198', {
    timeout: 10_000,
  });
  await expect(implementing.getByTestId('run-card')).toHaveCount(0);
  await api.dispose();
});

test('slash focuses the search box and filters cards', async ({ page }) => {
  await login(page);
  await page.keyboard.press('/');
  await expect(page.locator('#board-search')).toBeFocused();
  await page.keyboard.type('PLAT');
  await expect(page.getByTestId('run-card')).toHaveCount(1);
  await expect(page.getByTestId('run-card')).toContainText('PLAT-412');
});
