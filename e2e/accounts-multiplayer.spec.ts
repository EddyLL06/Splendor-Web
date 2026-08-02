import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

const register = async (page: Page, input: { email: string; username: string }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Email address').fill(input.email);
  await page.getByLabel('Username').fill(input.username);
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await expect(page.getByText('Code requested. Check your inbox and spam folder.')).toBeVisible();
  const codeResponse = await page.request.get(
    `/api/test/email-code?email=${encodeURIComponent(input.email)}&purpose=registration`,
  );
  expect(codeResponse.ok()).toBeTruthy();
  const { code } = (await codeResponse.json()) as { code: string };
  await page.getByLabel('Six-digit email code').fill(code);
  await page.getByLabel('Password').fill('BrowserPass!123');
  await page.getByRole('button', { name: 'Create account and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Turn raw gems into prestige.' })).toBeVisible();
};

const currentMatchID = (page: Page): string => {
  const value = new URL(page.url()).searchParams.get('match');
  if (!value) throw new Error('Expected a match query parameter.');
  return value;
};

test('accounts, private/public rooms, multiplayer, reconnect, localization, avatar, and logout', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const suffix = Date.now().toString(36);
  await register(alice, { email: `alice-${suffix}@example.test`, username: `Alice_${suffix}` });
  await register(bob, { email: `bob-${suffix}@example.test`, username: `Bob_${suffix}` });

  await alice.locator('.segmented-control button').first().click();
  await alice.locator('.visibility-option').filter({ hasText: 'Private' }).click();
  await alice.getByRole('button', { name: 'Create match' }).click();
  await expect(alice.getByRole('heading', { name: 'Your table is ready.' })).toBeVisible();
  const privateID = currentMatchID(alice);

  await bob.reload();
  await expect(bob.locator('.match-row').filter({ hasText: privateID })).toHaveCount(0);
  await bob.goto(`/?match=${encodeURIComponent(privateID)}`);
  await expect(bob.getByRole('heading', { name: 'Join shared match' })).toBeVisible();
  await bob.getByRole('button', { name: 'Claim an open seat' }).click();
  await expect(alice.getByRole('button', { name: 'Start game' })).toBeEnabled();
  await alice.getByRole('button', { name: 'Start game' }).click();
  await expect(alice.locator('.game-shell')).toBeVisible({ timeout: 15_000 });
  await expect(bob.locator('.game-shell')).toBeVisible({ timeout: 15_000 });

  for (const page of [alice, bob]) {
    await page.evaluate((matchID) => {
      sessionStorage.removeItem(`gem-council-session:${matchID}`);
    }, privateID);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Turn raw gems into prestige.' })).toBeVisible();
  }

  await alice.locator('.segmented-control button').first().click();
  await alice.getByRole('button', { name: 'Create match' }).click();
  await expect(alice.getByRole('heading', { name: 'Your table is ready.' })).toBeVisible();
  const publicID = currentMatchID(alice);
  await bob.reload();
  const publicRow = bob.locator('.match-row').filter({ hasText: publicID });
  await expect(publicRow).toBeVisible({ timeout: 10_000 });
  await publicRow.getByRole('button', { name: 'Join' }).click();
  await expect(alice.getByRole('button', { name: 'Start game' })).toBeEnabled();
  await alice.getByRole('button', { name: 'Start game' }).click();
  await expect(alice.locator('.game-shell')).toBeVisible({ timeout: 15_000 });
  await expect(bob.locator('.game-shell')).toBeVisible({ timeout: 15_000 });

  const aliceTurn = await alice
    .getByRole('banner')
    .getByText('Your turn', { exact: true })
    .isVisible();
  const actor = aliceTurn ? alice : bob;
  const observer = aliceTurn ? bob : alice;
  const tokenButtons = actor.locator('.take-token-grid button');
  await tokenButtons.nth(0).click();
  await tokenButtons.nth(1).click();
  await tokenButtons.nth(2).click();
  await actor.getByRole('button', { name: 'Confirm token action' }).click();
  await expect(observer.locator('.action-log li').first()).not.toContainText('The first move will appear here.');

  await observer.reload();
  await expect(observer.locator('.game-shell')).toBeVisible({ timeout: 15_000 });
  await observer.getByRole('button', { name: '中文' }).click();
  await expect(observer.getByText('行动日志')).toBeVisible();
  await observer.getByRole('button', { name: 'EN' }).click();

  const avatar = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#b88b35' } }).png().toBuffer();
  await observer.locator('.account-identity').click();
  await observer.locator('.profile-modal input[type=file]').setInputFiles({
    name: 'avatar.png', mimeType: 'image/png', buffer: avatar,
  });
  await expect(observer.getByRole('button', { name: 'Remove avatar' })).toBeVisible();
  await observer.getByRole('button', { name: 'Remove avatar' }).click();
  await expect(observer.getByRole('button', { name: 'Remove avatar' })).toHaveCount(0);
  await observer.locator('.profile-modal .modal-actions').getByRole('button', { name: 'Close' }).click();

  await observer.getByRole('button', { name: 'Sign out' }).click();
  await expect(observer.getByRole('tab', { name: 'Sign in' })).toBeVisible();
  await expect(observer.locator('.game-shell')).toHaveCount(0);

  await aliceContext.close();
  await bobContext.close();
});
