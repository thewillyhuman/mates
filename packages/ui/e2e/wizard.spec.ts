import { expect, test, type Page } from '@playwright/test';
import { ADMIN, adminContext } from './seed.js';

/** Settings wizard (§6.2, §13.6): every step reachable, Test buttons answer, checklist summarises. */
async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

test('the wizard stores a credential, runs its test and the checklist reflects it', async ({
  page,
  baseURL,
}) => {
  await (await adminContext(baseURL!)).dispose(); // makes sure the admin exists
  await login(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Setup checklist' })).toBeVisible();

  await page.getByRole('link', { name: '1 · Anthropic' }).click();
  const field = page.getByTestId('credential-anthropic_api_key');
  await field.getByRole('textbox').fill('sk-ant-playwright');
  await field.getByRole('button', { name: 'Store' }).click();
  await expect(field).toContainText('· set');
  await field.getByTestId('test-anthropic_api_key').click();
  await expect(field.getByRole('status')).toContainText('fake-Claude mode');

  await page.getByRole('link', { name: '2 · Jira' }).click();
  await page.getByLabel('Base URL').fill('https://jira.example.com');
  await page.getByLabel('Value').fill('mates@example.com');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.result-ok')).toContainText('Saved');
  await page.getByTestId('credential-jira_token').getByRole('textbox').fill('jira-token');
  await page.getByTestId('credential-jira_token').getByRole('button', { name: 'Store' }).click();
  await page.getByTestId('test-jira_token').click();
  // No real Jira behind it: the test must fail with a reason, not hang.
  await expect(page.getByTestId('credential-jira_token').getByRole('status')).toContainText('✗', {
    timeout: 30_000,
  });

  await page.getByRole('link', { name: '5 · Models & budgets' }).click();
  await expect(page.getByLabel('Max iterations')).toHaveValue('4');
  await page.getByLabel('Max iterations').fill('6');
  await page.getByRole('button', { name: 'Save' }).last().click();
  await expect(page.locator('.result-ok').last()).toContainText('Saved');

  await page.getByRole('link', { name: 'Checklist' }).click();
  await expect(page.locator('table.data')).toContainText('Anthropic');
  await expect(page.locator('table.data tr', { hasText: 'Anthropic' })).toContainText('ok');
  await page.screenshot({ path: 'e2e/screenshots/settings.png', fullPage: true });
});

test('usage, tickets and mates pages render', async ({ page }) => {
  await login(page);
  await page.goto('/usage');
  await expect(page.getByRole('heading', { name: 'Usage' })).toBeVisible();
  await expect(page.locator('svg.chart').first()).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/usage.png', fullPage: true });
  await page.goto('/tickets');
  await expect(page.getByRole('heading', { name: 'Tickets' })).toBeVisible();
  await expect(page.locator('table.data')).toContainText('API-198');
  await page.screenshot({ path: 'e2e/screenshots/tickets.png', fullPage: true });
  await page.goto('/mates');
  await expect(page.getByRole('heading', { name: 'Mates' })).toBeVisible();
  await expect(page.locator('body')).toContainText('webhook-service');
  await page.screenshot({ path: 'e2e/screenshots/mates.png', fullPage: true });
});
