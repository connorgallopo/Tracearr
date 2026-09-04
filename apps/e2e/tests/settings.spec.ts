import { test, expect } from '@playwright/test';
import path from 'path';

test.use({ storageState: path.resolve(import.meta.dirname, '../.auth/user.json') });

test.describe('Settings', () => {
  test('lands on Appearance and lists every group in the nav', async ({ page }) => {
    await page.goto('/settings');

    await expect(page).toHaveURL(/\/settings\/general\/appearance$/);
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Appearance', level: 2 })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    for (const group of ['General', 'Servers', 'Notifications', 'Access', 'Data & API']) {
      await expect(nav.getByText(group, { exact: true })).toBeVisible();
    }
    await expect(nav.getByRole('link', { name: 'Newsletters' })).toHaveCount(0);
  });

  test('navigates between sections through the nav column', async ({ page }) => {
    await page.goto('/settings');

    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await nav.getByRole('link', { name: 'Connections' }).click();
    await expect(page).toHaveURL(/\/settings\/servers\/connections$/);
    await expect(page.getByRole('heading', { name: 'Connections', level: 2 })).toBeVisible();

    await nav.getByRole('link', { name: 'Jobs' }).click();
    await expect(page).toHaveURL(/\/settings\/data\/jobs$/);
    await expect(page.getByRole('heading', { name: 'Jobs', level: 2 })).toBeVisible();
  });

  test.describe('old bookmarks', () => {
    const redirects: [string, RegExp][] = [
      ['/settings/servers', /\/settings\/servers\/connections$/],
      ['/settings/notifications', /\/settings\/notifications\/destinations$/],
      ['/settings/access', /\/settings\/access\/guest$/],
      ['/settings/mobile', /\/settings\/access\/mobile$/],
      ['/settings/tailscale', /\/settings\/access\/remote$/],
      ['/settings/import', /\/settings\/data\/import$/],
      ['/settings/jobs', /\/settings\/data\/jobs$/],
      ['/settings/backup', /\/settings\/data\/backup$/],
    ];

    for (const [from, to] of redirects) {
      test(`${from} still works`, async ({ page }) => {
        await page.goto(from);
        await expect(page).toHaveURL(to);
      });
    }
  });

  test('navigates through the select on a phone-sized viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/settings');

    // The layout switches on the settings container's width, and a phone viewport
    // is the only way Playwright can make that container narrow.
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeHidden();

    await page.getByRole('combobox', { name: 'Settings section' }).click();
    await page.getByRole('option', { name: 'Data & API / Backup' }).click();

    await expect(page).toHaveURL(/\/settings\/data\/backup$/);
    await expect(page.getByRole('heading', { name: 'Backup', level: 2 })).toBeVisible();
  });
});
