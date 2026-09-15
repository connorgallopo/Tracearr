import { test, expect } from '@playwright/test';
import path from 'path';
import { OTHER_VIEWER_SERVER_USER_ID } from '../seed/fixtures';

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
    await expect(nav.getByRole('link', { name: 'Newsletters' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Email' })).toBeVisible();
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

test.describe('Newsletters', () => {
  const destinationName = 'E2E mail';

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: path.resolve(import.meta.dirname, '../.auth/user.json'),
    });
    const page = await context.newPage();
    // Loopback is inside the SSRF policy; nothing listens on 1025 in CI, and no journey sends.
    const response = await page.request.post('/api/v1/destinations', {
      data: {
        name: destinationName,
        type: 'email',
        config: {
          preset: 'custom',
          host: '127.0.0.1',
          port: '1025',
          security: 'none',
          fromName: 'Tracearr',
          fromAddress: 'news@example.test',
          messagesPerSecond: '2',
        },
        events: [],
        enabled: true,
      },
    });
    expect([201, 409]).toContain(response.status());
    await context.close();
  });

  test('creates, previews, checks history and deletes a newsletter', async ({ page }) => {
    const name = `E2E weekly ${Date.now()}`;
    await page.goto('/settings/notifications/newsletters');
    await page.getByRole('button', { name: 'New newsletter' }).first().click();
    await expect(page).toHaveURL(/\/settings\/notifications\/newsletters\/new$/);

    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('From name').fill('Family Media');
    await page.getByRole('combobox', { name: 'Email destination' }).click();
    await page.getByRole('option', { name: destinationName }).click();

    // Preview before the first save: the draft route renders it, and no row exists yet.
    await page.getByRole('button', { name: 'Preview', exact: true }).first().click();
    await expect(page.getByText('Preview of unsaved changes')).toBeVisible();
    await expect(page.locator('iframe[title="Preview"]')).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/notifications\/newsletters\/new$/);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/notifications\/newsletters\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();

    await page.getByRole('button', { name: 'Preview' }).click();
    const frame = page.locator('iframe[title="Preview"]');
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute('sandbox', '');
    await expect(page.getByRole('dialog')).toContainText("What's new on");
    await page.keyboard.press('Escape');

    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.getByRole('heading', { name: 'No sends yet', level: 3 })).toBeVisible();

    await page.getByRole('tab', { name: 'Edit' }).click();
    await page.getByLabel('Subject').fill('Edited subject');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Unsaved changes')).toHaveCount(0);

    await page.goto('/settings/notifications/newsletters');
    const row = page.getByRole('listitem').filter({ hasText: name });
    await row.getByRole('button', { name: 'Newsletter actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(row).toHaveCount(0);
  });

  test('round-trips a branding change and a suppression', async ({ page }) => {
    await page.goto('/settings/notifications/email');
    const footer = `See you next week ${Date.now()}`;
    await page.getByLabel('Footer text').fill(footer);
    await page.getByRole('button', { name: 'Save branding' }).click();
    await page.reload();
    await expect(page.getByLabel('Footer text')).toHaveValue(footer);

    const address = `gone-${Date.now()}@example.test`;
    await page.getByRole('button', { name: 'Add address' }).click();
    await page.getByLabel('Email address').fill(address);
    await page.getByRole('button', { name: 'Suppress' }).click();
    const row = page.getByRole('listitem').filter({ hasText: address });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Added by hand');
    await row.getByRole('button', { name: `Remove ${address} from the list` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(row).toHaveCount(0);
  });

  test('gives a member a contact email from the user page', async ({ page }) => {
    await page.goto(`/users/${OTHER_VIEWER_SERVER_USER_ID}`);
    await page.getByRole('button', { name: 'Edit name and contact email' }).first().click();
    const email = `viewer-${Date.now()}@example.test`;
    await page.getByLabel('Contact email', { exact: true }).fill(email);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(`Newsletter address: ${email}`)).toBeVisible();
  });
});
