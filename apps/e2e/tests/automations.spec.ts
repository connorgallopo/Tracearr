import path from 'path';
import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: path.resolve(import.meta.dirname, '../.auth/user.json') });

/** Every automation this spec creates, so a failed run's leftovers are still findable. */
const PREFIX = 'E2E Automation';

/** A run that failed mid-flow leaves its row behind; a fresh name never collides with it. */
const uniqueName = (label: string) => `${PREFIX} ${label} ${Date.now().toString().slice(-6)}`;

/** The scratch flow, which every test here needs before it has anything to open. */
async function buildAutomation(page: Page, name: string) {
  await page.goto('/automations/new');
  await expect(page.getByRole('heading', { name: 'New automation', level: 1 })).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill(name);

  await page.getByRole('button', { name: 'Choose what starts it' }).click();
  await page.getByRole('option', { name: /Playback confirmed/ }).click();

  await page.getByRole('button', { name: 'Choose what happens' }).click();
  await page.getByRole('option', { name: /Send Notification/ }).click();
  await page.getByRole('button', { name: 'Browser toasts' }).click();

  await page.getByRole('button', { name: 'Create automation' }).click();

  await expect(page).toHaveURL(/\/automations\/[0-9a-f-]{36}$/);
}

/**
 * The row's switch is labelled "Turn <name> on or off", so a cell lookup by name finds
 * two cells. Only the row itself holds the name once.
 */
function rowFor(page: Page, name: string) {
  return page.getByRole('row').filter({ hasText: name });
}

async function deleteAutomation(page: Page, name: string) {
  await page.goto('/automations');
  await rowFor(page, name).getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();

  await expect(rowFor(page, name)).toHaveCount(0);
}

/**
 * Through the API, because a test that failed mid-flow is nowhere near the list. Sweeps
 * the whole prefix, so rows an earlier run abandoned go too.
 */
async function sweepAutomations(page: Page) {
  const listed = await page.request.get(
    `/api/v1/automations?search=${encodeURIComponent(PREFIX)}&pageSize=100`
  );
  // A cleanup that throws would bury whatever the test itself was failing on.
  if (!listed.ok()) return;

  const { data } = (await listed.json()) as { data: { id: string }[] };
  if (data.length === 0) return;

  await page.request.delete('/api/v1/automations/bulk', {
    data: { ids: data.map((automation) => automation.id) },
  });
}

/** The import test stores a template too; it can only go once no automation uses it. */
async function sweepTemplates(page: Page) {
  const listed = await page.request.get('/api/v1/templates');
  if (!listed.ok()) return;

  const { data } = (await listed.json()) as {
    data: { id: string; name: string; builtin: boolean }[];
  };
  for (const template of data) {
    if (template.builtin || !template.name.startsWith(PREFIX)) continue;
    await page.request.delete(`/api/v1/templates/${template.id}`);
  }
}

test.describe('Automations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/automations');
    await expect(page.getByRole('heading', { name: 'Automations', level: 1 })).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    await sweepAutomations(page);
    await sweepTemplates(page);
  });

  test('builds an automation from scratch on the builder page', async ({ page }) => {
    const name = uniqueName('Scratch');

    await buildAutomation(page, name);

    await page.goto('/automations');
    await expect(rowFor(page, name)).toBeVisible();

    await deleteAutomation(page, name);
  });

  test('edits an automation from its detail page', async ({ page }) => {
    const name = uniqueName('Edit');
    const renamed = uniqueName('Edited');

    await buildAutomation(page, name);

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page).toHaveURL(/\/automations\/[0-9a-f-]{36}\/edit$/);
    await expect(page.getByRole('heading', { name: 'Edit automation', level: 1 })).toBeVisible();

    await page.getByLabel('Name', { exact: true }).fill(renamed);
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page).toHaveURL(/\/automations\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: renamed, level: 1 })).toBeVisible();

    await page.goto('/automations');
    await expect(rowFor(page, renamed)).toBeVisible();

    await deleteAutomation(page, renamed);
  });

  test('starts a ready-made automation from the gallery', async ({ page }) => {
    const name = uniqueName('Gallery');

    await page.getByRole('button', { name: 'New automation' }).click();

    // Each view names the dialog, and the server picker's popover is a dialog too,
    // so every locator here says which one it means.
    const gallery = page.getByRole('dialog', { name: 'New automation' });
    await expect(gallery).toBeVisible();
    await gallery.getByRole('option', { name: /Stream started/ }).click();

    const form = page.getByRole('dialog', { name: 'Stream started' });
    // Naming it first stops the server pick from rewriting the name underneath.
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByRole('button', { name: 'Browser toasts' }).click();

    await form.getByRole('combobox', { name: 'Which server' }).click();
    await page.getByRole('option').nth(1).click();

    await form.getByRole('button', { name: 'Use this' }).click();

    await expect(form).toBeHidden();
    await expect(rowFor(page, name)).toBeVisible();

    await deleteAutomation(page, name);
  });

  test('exports one automation as a code and pastes it back in', async ({ page }) => {
    const name = uniqueName('Share');

    await buildAutomation(page, name);

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const exportDialog = page.getByRole('dialog', { name: 'Share this automation' });
    await expect(exportDialog.getByRole('heading', { name: 'In plain words' })).toBeVisible();

    // The code is the body, and it is the only block here: the JSON sits behind the
    // gallery section, so a second `pre` would mean it is being offered twice.
    await expect(exportDialog.locator('pre')).toHaveCount(1);
    const code = (await exportDialog.locator('pre').innerText()).trim();
    expect(code).toMatch(/^tracearr1\./);
    await expect(exportDialog.getByRole('button', { name: 'Copy the share code' })).toBeVisible();

    const close = exportDialog.getByRole('button', { name: 'Close' });
    await expect(close).toHaveCount(1);
    await close.click();
    await expect(exportDialog).toBeHidden();

    await page.goto('/automations');
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    const paste = page.getByRole('dialog', { name: 'Paste a share code' });
    await expect(
      paste.getByText('Shared automations are listed at docs.tracearr.com/templates.')
    ).toBeVisible();
    await paste.getByRole('textbox', { name: 'Paste a share code' }).fill(code);
    await paste.getByRole('button', { name: 'Check it' }).click();

    const review = page.getByRole('dialog', { name });
    // A pasted code is not one Tracearr ships, so the review claims only that it read it.
    await expect(review.getByText('Tracearr can read this code.')).toBeVisible();
    await expect(
      review.getByText('Nothing in a code says who wrote it or whether it is safe.')
    ).toBeVisible();
    await expect(review.getByRole('heading', { name: 'In plain words' })).toBeVisible();

    await review.getByRole('button', { name: 'Browser toasts' }).click();
    await review.getByRole('button', { name: 'Add it' }).click();

    await expect(review).toBeHidden();
    // It lands paused, so the row that came back from the code says Disabled.
    await expect(rowFor(page, name).filter({ hasText: 'Disabled' })).toBeVisible();
  });

  test('filters the list by kind', async ({ page }) => {
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByLabel('Kind').click();
    await page.getByRole('option', { name: 'Violation' }).click();

    await expect(page).toHaveURL(/kind=policy/);
  });
});
