import { expect, test, type Page } from '@playwright/test';

const registerHost = async (page: Page): Promise<void> => {
  const suffix = Date.now().toString(36);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Email address').fill(`e2e-bot-${suffix}@example.test`);
  await page.getByLabel('Username').fill(`BotHost_${suffix}`);
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await expect(page.getByText('Code requested. Check your inbox and spam folder.')).toBeVisible();
  const codeResponse = await page.request.get(
    `/api/test/email-code?email=${encodeURIComponent(`e2e-bot-${suffix}@example.test`)}&purpose=registration`,
  );
  expect(codeResponse.ok()).toBeTruthy();
  const { code } = (await codeResponse.json()) as { code: string };
  await page.getByLabel('Six-digit email code').fill(code);
  await page.getByLabel('Password').fill('BrowserPass!123');
  await page.getByRole('button', { name: 'Create account and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Turn raw gems into prestige.' })).toBeVisible();
};

const humanMove = async (page: Page): Promise<void> => {
  const tokenButtons = page.locator('.take-token-grid button');
  await tokenButtons.nth(0).click();
  await tokenButtons.nth(1).click();
  await tokenButtons.nth(2).click();
  await page.getByRole('button', { name: 'Confirm token action' }).click();
};

test('host adds an Easy bot, starts, and the bot plays a full turn through the UI', async ({ page }) => {
  await registerHost(page);

  await page.locator('.segmented-control button').first().click();
  await page.locator('.visibility-option').filter({ hasText: 'Private' }).click();
  await page.getByRole('button', { name: 'Create match' }).click();
  await expect(page.getByRole('heading', { name: 'Your table is ready.' })).toBeVisible();

  const openSeat = page.locator('.seat-row').filter({ hasText: 'Open seat' });
  await openSeat.getByRole('button', { name: 'Add bot' }).click();
  await expect(page.locator('.seat-row').filter({ hasText: 'Bot 2' })).toBeVisible();
  await expect(page.locator('.seat-row').filter({ hasText: 'Bot · Easy' })).toBeVisible();

  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page.locator('.game-shell')).toBeVisible({ timeout: 15_000 });

  // Wait until it is the human's turn (the bot moves first when it is the
  // first player), then resync the page and make one human move.
  await expect
    .poll(
      () => page.getByRole('banner').getByText('Your turn', { exact: true }).isVisible(),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.reload();
  await expect(page.locator('.game-shell')).toBeVisible({ timeout: 15_000 });
  await humanMove(page);
  const logCount = await page.locator('.action-log li').count();
  expect(logCount).toBeGreaterThan(0);

  // The Easy bot must play its next turn through the authoritative chain.
  await expect
    .poll(async () => page.locator('.action-log li').count(), { timeout: 20_000 })
    .toBeGreaterThan(logCount);
});
