import { test, expect } from '@playwright/test';
import path from 'path';

test.use({ storageState: path.resolve(import.meta.dirname, '../.auth/user.json') });

test.describe('Page Navigation', () => {
  test('can navigate to history page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'History' }).click();
    await expect(page.getByRole('heading', { name: 'History', level: 1 })).toBeVisible();
  });

  test('can navigate to map page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Map' }).click();
    // Map page has no heading — verify the MapLibre map container rendered
    await expect(page.locator('.maplibregl-map')).toBeVisible();
  });

  test('can navigate to users page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Users', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible();
  });

  test('can navigate to automations page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Automations' }).click();
    await expect(page.getByRole('heading', { name: 'Automations', level: 1 })).toBeVisible();
  });

  test('can navigate to violations page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Violations' }).click();
    await expect(page.getByRole('heading', { name: 'Violations', level: 1 })).toBeVisible();
  });

  test('can navigate to settings page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/general\/appearance$/);
  });
});

test.describe('Stats Navigation', () => {
  test('can navigate to activity page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Activity' }).click();
    await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
  });

  test('can navigate to stats users page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'By User' }).click();
    // Stats > Users has no h1 — shows "Top 3" with data or "No activity yet" when empty
    await expect(
      page.getByRole('heading', { name: 'Top 3' }).or(page.getByText('No activity yet'))
    ).toBeVisible();
  });
});

test.describe('Media Navigation', () => {
  test('can navigate to the media overview page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Overview' }).click();
    await expect(page.getByRole('heading', { name: 'Library', level: 1 })).toBeVisible();
  });

  test('can navigate to the browse page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Browse' }).click();
    await expect(page).toHaveURL(/\/media\/browse$/);
  });

  test('can navigate to quality page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Quality' }).click();
    await expect(page.getByRole('heading', { name: 'Quality', level: 1 })).toBeVisible();
  });

  test('can navigate to storage page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Storage' }).click();
    await expect(page.getByRole('heading', { name: 'Storage', level: 1 })).toBeVisible();
  });

  test('can navigate to watch page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Watch' }).click();
    await expect(page.getByRole('heading', { name: 'Watch Analytics', level: 1 })).toBeVisible();
  });
});

test.describe('Device And Bandwidth Navigation', () => {
  test('can navigate to devices page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Devices' }).click();
    await expect(
      page.getByRole('heading', { name: 'Device Compatibility', level: 1 })
    ).toBeVisible();
  });

  test('can navigate to bandwidth page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Bandwidth' }).click();
    await expect(page.getByRole('heading', { name: 'Bandwidth', level: 1 })).toBeVisible();
  });
});
