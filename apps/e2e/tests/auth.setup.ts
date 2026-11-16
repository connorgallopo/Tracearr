import { test as setup, expect } from '@playwright/test';
import path from 'path';

const STORAGE_STATE_PATH = path.resolve(import.meta.dirname, '../.auth/user.json');

const E2E_USER = {
  email: 'e2e@tracearr.test',
  name: 'E2E Owner',
  username: 'e2eowner',
  password: 'TestPassword123!',
};

// No server of this type is seeded, so the connect step offers Skip instead of Continue.
const FIRST_RUN_SERVER = 'Emby';

setup('authenticate', async ({ page }) => {
  await page.goto('/login');

  const claimCodeInput = page.locator('#gate-claimCode');
  const serverPicker = page.getByRole('radiogroup', { name: 'Which media server do you use?' });
  const identifierInput = page.locator('#identifier');

  await expect(
    claimCodeInput.or(serverPicker).or(identifierInput),
    'An owner who signed up without a password (Plex or tofa) leaves no password sign-in here; ' +
      'start from a fresh database'
  ).toBeVisible({ timeout: 15_000 });

  if (await claimCodeInput.isVisible()) {
    const claimCode = process.env.CLAIM_CODE;
    if (!claimCode) {
      throw new Error(
        'Claim code gate is showing but CLAIM_CODE env var is not set. ' +
          'Set CLAIM_CODE to match the server configuration.'
      );
    }
    await claimCodeInput.fill(claimCode);
    await page.getByRole('button', { name: 'Validate Claim Code' }).click();
    await expect(serverPicker).toBeVisible();
  }

  if (await serverPicker.isVisible()) {
    await page.getByRole('radio', { name: FIRST_RUN_SERVER }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.locator('#name').fill(E2E_USER.name);
    await page.locator('#username').fill(E2E_USER.username);
    await page.locator('#email').fill(E2E_USER.email);
    await page.locator('#password').fill(E2E_USER.password);
    await page.getByRole('button', { name: 'Create Account' }).click();

    await expect(page).toHaveURL(/\/setup\?type=emby$/, { timeout: 15_000 });
    await page.getByRole('button', { name: 'Skip' }).click();
  } else {
    await identifierInput.fill(E2E_USER.email);
    await page.locator('#password').fill(E2E_USER.password);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  }

  await expect(page).toHaveURL('/', { timeout: 15_000 });

  // The session is a cookie, so storage state carries it to the other projects.
  await page.context().storageState({ path: STORAGE_STATE_PATH });
});
