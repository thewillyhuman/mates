import { expect, test, type Page } from '@playwright/test';
import { ADMIN, adminContext, configure, play, startOnly, trigger } from './seed.js';

/** Ticket detail (§13.2): stepper, timeline with the verdict, live tail, facts, nudge. */
async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('detail shows the timeline with the verdict, the live tail and the run facts', async ({
  page,
  baseURL,
}) => {
  const api = await adminContext(baseURL!);
  await configure(api);
  const run = await trigger(api, 'API-199');
  await play(api, run.id, 'intake_implementable');
  await play(api, run.id, 'impl_iter1_green');
  await play(api, run.id, 'review_changes_requested_2_blocking');
  await play(api, run.id, 'impl_iter2_addressed');
  await startOnly(api, run.id); // reviewer 2 is live

  await login(page);
  await page.goto(`/runs/${run.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('API-199');
  await expect(page.locator('.stepper')).toContainText('In review · 2/4');
  const timeline = page.getByTestId('timeline');
  await expect(timeline).toContainText('intake.passed');
  await expect(timeline).toContainText('Changes requested');
  await expect(timeline).toContainText('B1');
  await expect(timeline).toContainText('Backoff is unbounded');
  await expect(timeline).toContainText('+186');
  await timeline.getByRole('button', { name: /Show 3 nits/ }).click();
  await expect(timeline).toContainText('N1');
  const tail = page.getByTestId('live-tail');
  await expect(tail).toContainText('Live tail · reviewer mate 2');
  await expect(tail).toContainText('run pnpm test');
  await expect(page.locator('.facts')).toContainText('2 of 4');
  await expect(page.locator('.facts')).toContainText('of $25.00');
  await page.screenshot({ path: 'e2e/screenshots/detail.png', fullPage: true });

  // Live: the verdict arrives over SSE and the stage moves on without a reload.
  await play(api, run.id, 'review_approve');
  await expect(timeline).toContainText('Approved', { timeout: 10_000 });
  await expect(page.locator('.stepper')).toContainText('MR ready');
  await api.dispose();
});

test('a nudge is recorded and shown in the timeline', async ({ page, baseURL }) => {
  const api = await adminContext(baseURL!);
  const run = await trigger(api, 'API-200');
  await play(api, run.id, 'intake_implementable');
  await login(page);
  await page.goto(`/runs/${run.id}`);
  await page.getByLabel('Nudge text').fill('Use the existing BackoffSchedule helper.');
  await page.getByRole('button', { name: 'Send to next iteration' }).click();
  await expect(page.getByTestId('timeline')).toContainText('nudge.added', { timeout: 10_000 });
  await expect(page.getByTestId('timeline')).toContainText(
    'Use the existing BackoffSchedule helper.',
  );
  // Implementer 1 was spawned before the nudge; the note goes to the next iteration (§7.5 rule 9).
  await play(api, run.id, 'impl_iter1_green');
  await play(api, run.id, 'review_changes_requested_2_blocking');
  await expect(page.getByTestId('timeline')).toContainText('nudge.consumed', { timeout: 10_000 });
  await api.dispose();
});

test('cancel asks for confirmation and Esc closes the dialog', async ({ page, baseURL }) => {
  const api = await adminContext(baseURL!);
  const run = await trigger(api, 'API-201');
  await login(page);
  await page.goto(`/runs/${run.id}`);
  await page.getByRole('button', { name: 'Cancel run' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel run' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel run' }).click();
  await expect(page.locator('.chip-gray')).toContainText('Cancelled');
  await api.dispose();
});
