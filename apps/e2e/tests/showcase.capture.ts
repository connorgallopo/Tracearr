/**
 * The showcase capture run: seeds the fixed cast into tracearr_showcase, then
 * writes one webp per screenshot the website uses. Nothing here asserts
 * product behaviour; a step fails only when a frame cannot be produced. Only runs with SHOWCASE=1 (see apps/e2e/README.md); the
 * database switch and the guard live in apps/e2e/seed/env.ts.
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import path from 'path';
import pg from 'pg';
import type {
  Destination,
  Newsletter,
  NewsletterPreview,
  NewsletterRecipientsView,
} from '@tracearr/shared';
import { e2eDatabaseUrl, e2eRedisPrefix, e2eRedisUrl } from '../seed/env';
import { assertSafeDatabase } from '../seed/guard';
import { startAssetServer, type AssetServer } from '../showcase/assetServer';
import { waitForImages, writeWebp } from '../showcase/capture';
import {
  buildActiveSessions,
  seedAutomations,
  seedNewsletterSend,
  seedShowcase,
  writeActiveSessions,
  type ShowcaseIds,
} from '../showcase/seed';

test.skip(!process.env.SHOWCASE, 'Showcase captures only run with SHOWCASE=1');

const ASSET_PORT = 4599;
const ASSET_BASE_URL = `http://127.0.0.1:${ASSET_PORT}`;
const ASSETS_DIR = path.resolve(import.meta.dirname, '../showcase/assets');
const OUT_DIR = process.env.SHOWCASE_OUT ?? path.resolve(import.meta.dirname, '../showcase/out');
const STORAGE_STATE = path.resolve(import.meta.dirname, '../.auth/user.json');
const BASE_URL = 'http://localhost:5173';

const READY = { timeout: 20_000 } as const;
const CHART_SETTLE_MS = 500;
const MAP_SETTLE_MS = 1_500;

test.use({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  timezoneId: 'America/Denver',
  locale: 'en-US',
  storageState: STORAGE_STATE,
});

let assets: AssetServer;
let ids: ShowcaseIds;
let automationIds: Record<string, string>;
let newsletterId: string;
let digestHtml: string;

async function postJson<T>(api: APIRequestContext, url: string, data: unknown): Promise<T> {
  const response = await api.post(url, { data });
  if (!response.ok()) {
    throw new Error(`POST ${url} returned ${response.status()}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function getJson<T>(api: APIRequestContext, url: string): Promise<T> {
  const response = await api.get(url);
  if (!response.ok()) {
    throw new Error(`GET ${url} returned ${response.status()}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function seedEmail(api: APIRequestContext, client: pg.Client, now: Date): Promise<void> {
  const email = await postJson<Destination>(api, '/api/v1/destinations', {
    name: 'Postmark',
    type: 'email',
    config: {
      preset: 'postmark',
      host: 'smtp.postmarkapp.com',
      port: '587',
      security: 'starttls',
      username: 'showcase-server-token',
      password: 'showcase-server-token',
      fromName: "Jordan's server",
      fromAddress: 'tracearr@example.com',
    },
    events: [],
  });
  const discord = await postJson<Destination>(api, '/api/v1/destinations', {
    name: 'Discord #media',
    type: 'discord',
    config: { webhookUrl: 'https://discord.com/api/webhooks/1234567890/showcase' },
  });

  const newsletter = await postJson<Newsletter>(api, '/api/v1/newsletters', {
    name: "What's new this week",
    destinationId: email.id,
    schedule: { kind: 'weekly', dayOfWeek: 5, time: '18:00' },
    timezone: 'America/Denver',
    window: { kind: 'since_last_send', fallbackDays: 7 },
    scope: { serverIds: [ids.servers.plex, ids.servers.jellyfin], libraries: [] },
    sections: {
      movies: { enabled: true, max: 12 },
      shows: { enabled: true, max: 12, maxSeasonsPerShow: 8 },
      music: { enabled: false, max: 8 },
      mostWatched: { enabled: true, max: 5 },
    },
    subject: 'New this week on Plex',
    senderName: 'Jordan',
    recipients: { members: true, extraAddresses: [], excludeUserIds: [] },
    imageMode: 'auto',
    links: { tracearr: true },
  });
  newsletterId = newsletter.id;

  const preview = await postJson<NewsletterPreview>(
    api,
    `/api/v1/newsletters/${newsletter.id}/preview`,
    {}
  );
  const [union] = preview.variants;
  digestHtml = union.html;

  const view = await getJson<NewsletterRecipientsView>(
    api,
    `/api/v1/newsletters/${newsletter.id}/recipients`
  );

  automationIds = await seedAutomations(client, ids, { discord: discord.id, email: email.id });

  await seedNewsletterSend(client, {
    newsletterId: newsletter.id,
    destinationId: email.id,
    subject: union.subject,
    // The preview route renders html only; no capture reads the text part.
    text: union.subject,
    html: union.html,
    recipients: view.recipients
      .filter((recipient) => !recipient.suppressed)
      .map((recipient) => ({ address: recipient.address, userId: recipient.userId })),
    now,
  });
}

test.beforeAll(async ({ playwright }) => {
  assets = await startAssetServer(ASSET_PORT, ASSETS_DIR);

  const client = new pg.Client({ connectionString: e2eDatabaseUrl() });
  await client.connect();
  try {
    await assertSafeDatabase(client);

    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'owner' ORDER BY created_at ASC LIMIT 1`
    );
    const ownerId = rows[0]?.id;
    if (!ownerId) {
      throw new Error('No owner account found - the setup project must run before the showcase');
    }

    const now = new Date();
    ids = await seedShowcase(client, { ownerId, assetBaseUrl: ASSET_BASE_URL, now });

    const api = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: STORAGE_STATE,
    });
    try {
      await seedEmail(api, client, now);
    } finally {
      await api.dispose();
    }

    await writeActiveSessions(e2eRedisUrl(), e2eRedisPrefix(), buildActiveSessions(ids));
  } finally {
    await client.end();
  }
});

test.afterAll(async () => {
  await assets.close();
});

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([{ name: 'sidebar_state', value: 'true', url: BASE_URL }]);
  // The poller cannot reach the asset server's fake servers, so the health
  // banner would sit on top of every capture.
  await context.route('**/api/v1/servers/health', (route) => route.fulfill({ json: { data: [] } }));
  await page.addInitScript(() => {
    window.localStorage.setItem('tracearr-theme', 'dark');
  });
});

function outPath(name: string): string {
  return path.join(OUT_DIR, `${name}.webp`);
}

async function settle(page: Page, extraMs = 0): Promise<void> {
  await page.waitForLoadState('networkidle');
  await waitForImages(page);
  await page.waitForTimeout(CHART_SETTLE_MS + extraMs);
}

async function open(page: Page, route: string, anchor: Locator, what: string): Promise<void> {
  await page.goto(route);
  await expect(anchor, `${what} never appeared on ${route}`).toBeVisible(READY);
}

async function shot(page: Page, name: string): Promise<void> {
  await writeWebp(await page.screenshot({ type: 'png' }), outPath(name));
}

async function elementShot(target: Locator, name: string): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await writeWebp(await target.screenshot({ type: 'png' }), outPath(name));
}

/** A shadcn Card has no role of its own; its CardTitle renders an h3. */
function cardFor(page: Page, heading: string): Locator {
  return page
    .getByRole('heading', { name: heading, exact: true })
    .locator('xpath=ancestor::div[@data-slot="card"][1]');
}

test('dashboard', async ({ page }) => {
  await open(page, '/', page.getByRole('heading', { name: 'Now Playing' }), 'the Now Playing card');
  await settle(page);
  await shot(page, 'dashboard');
});

test('activity', async ({ page }) => {
  const heading = page.getByRole('heading', { name: 'Activity', level: 1 });
  await open(page, '/activity', heading, 'the Activity heading');
  await settle(page);
  await shot(page, 'activity');
});

test('map', async ({ page }) => {
  const canvas = page.locator('canvas.maplibregl-canvas');
  await open(page, '/map', canvas, 'the MapLibre canvas');
  await settle(page, MAP_SETTLE_MS);
  await shot(page, 'map');
});

test('automations', async ({ page }) => {
  const heading = page.getByRole('heading', { name: 'Automations', level: 1 });
  await open(page, '/automations', heading, 'the Automations heading');
  await settle(page);
  await shot(page, 'automations');
});

test('automation-detail', async ({ page }) => {
  const automationId = automationIds['concurrent-streams'];
  if (!automationId) {
    throw new Error('seedAutomations returned no id for concurrent-streams');
  }
  const heading = page.getByRole('heading', { name: 'Too many streams at once', level: 1 });
  await open(page, `/automations/${automationId}`, heading, 'the automation name heading');
  await settle(page);
  await shot(page, 'automation-detail');
});

test('violations', async ({ page }) => {
  const heading = page.getByRole('heading', { name: 'Violations', level: 1 });
  await open(page, '/violations', heading, 'the Violations heading');
  await settle(page);
  await shot(page, 'violations');
});

test('users', async ({ page }) => {
  const heading = page.getByRole('heading', { name: 'Users', level: 1 });
  await open(page, '/users', heading, 'the Users heading');
  await settle(page);
  await shot(page, 'users');
});

test('users-merge-suggestion', async ({ page }) => {
  const banner = page.getByRole('region', { name: 'Possible duplicate users' });
  await open(page, '/users', banner, 'the merge suggestions banner');
  await settle(page);
  await elementShot(banner, 'users-merge-suggestion');
});

test('users-merge-dialog', async ({ page }) => {
  const banner = page.getByRole('region', { name: 'Possible duplicate users' });
  await open(page, '/users', banner, 'the merge suggestions banner');
  await settle(page);

  const review = banner.getByRole('button', { name: 'Review' }).first();
  await expect(review, 'no Review button in the merge suggestions banner').toBeVisible(READY);
  await review.click();

  // "Merge" commits the merge and would delete the duplicate identity.
  const dialog = page.getByRole('dialog', { name: 'Merge users' });
  await expect(dialog, 'the merge dialog did not open after Review').toBeVisible(READY);
  await page.waitForTimeout(CHART_SETTLE_MS);
  await elementShot(dialog, 'users-merge-dialog');
});

test('user-detail', async ({ page }) => {
  const serverUserId = ids.people['maya']?.serverUserIds.plex;
  if (!serverUserId) {
    throw new Error('seedShowcase returned no Plex account for maya');
  }
  const heading = page.getByRole('heading', { name: 'Maya Chen', level: 1 });
  await open(page, `/users/${serverUserId}`, heading, "Maya Chen's name heading");
  await settle(page);
  await shot(page, 'user-detail');
});

test('user-accounts', async ({ page }) => {
  const serverUserId = ids.people['maya']?.serverUserIds.plex;
  if (!serverUserId) {
    throw new Error('seedShowcase returned no Plex account for maya');
  }
  const card = cardFor(page, 'Linked accounts');
  await open(page, `/users/${serverUserId}`, card, 'the linked accounts card');
  await settle(page);
  await elementShot(card, 'user-accounts');
});

test('stats-activity', async ({ page }) => {
  const heading = page.getByRole('heading', { name: 'Activity', level: 1 });
  await open(page, '/stats/activity', heading, 'the Activity heading');
  await settle(page);
  await shot(page, 'stats-activity');
});

test('stats-bandwidth', async ({ page }) => {
  const heading = page.getByRole('heading', { name: 'Bandwidth', level: 1 });
  await open(page, '/stats/bandwidth', heading, 'the Bandwidth heading');
  await settle(page);
  await shot(page, 'stats-bandwidth');
});

test('stats-devices', async ({ page }) => {
  const heading = page.getByRole('heading', { name: 'Device Compatibility', level: 1 });
  await open(page, '/stats/devices', heading, 'the Device Compatibility heading');
  await settle(page);
  await shot(page, 'stats-devices');
});

test('library-quality', async ({ page }) => {
  const heading = page.getByRole('heading', { name: 'Quality', level: 1 });
  await open(page, '/library/quality', heading, 'the Quality heading');
  await settle(page);
  await shot(page, 'library-quality');
});

test('library-storage', async ({ page }) => {
  const heading = page.getByRole('heading', { name: 'Storage', level: 1 });
  await open(page, '/library/storage', heading, 'the Storage heading');
  await settle(page);
  await shot(page, 'library-storage');
});

test('media-duplicates', async ({ page }) => {
  const card = cardFor(page, 'Duplicates');
  await open(page, '/library/storage', card, 'the Duplicates card');
  await settle(page);
  await elementShot(card, 'media-duplicates');
});

test('media-overview', async ({ page }) => {
  const heading = page.getByRole('heading', { name: 'Library', level: 1 });
  await open(page, '/media', heading, 'the Library heading');
  await settle(page);
  await shot(page, 'media-overview');
});

test('media-shelves', async ({ page }) => {
  const recentlyAdded = page.getByRole('region', { name: 'Recently Added Movies' });
  await open(page, '/media', recentlyAdded, 'the Recently Added Movies shelf');
  await settle(page);
  await elementShot(recentlyAdded.locator('xpath=..'), 'media-shelves');
});

test('media-browse', async ({ page }) => {
  const grid = page.getByRole('region', { name: 'Movies' });
  await open(page, '/media/browse', grid, 'the Movies grid');
  await expect(grid.getByRole('link').first(), 'the Movies grid rendered no cards').toBeVisible(
    READY
  );
  await settle(page);
  await shot(page, 'media-browse');
});

test('media-detail', async ({ page }) => {
  // The detail endpoint carries no poster; the hero shows the one the browse
  // grid cached, so a direct visit renders without it.
  const grid = page.getByRole('region', { name: 'Movies' });
  await open(page, '/media/browse', grid, 'the Movies grid');
  await page.getByRole('textbox', { name: 'Search titles' }).fill(ids.featuredMovieTitle);
  const card = grid.locator(`a[href*="${ids.featuredMovieMediaId}"]`).first();
  await expect(card, 'the featured movie did not come up in search').toBeVisible(READY);
  await card.click();
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading, 'the media title heading never appeared').toBeVisible(READY);
  await settle(page);
  await shot(page, 'media-detail');
});

test('settings-email', async ({ page }) => {
  const heading = page.getByRole('heading', { name: 'Email', level: 2, exact: true });
  await open(page, '/settings/notifications/email', heading, 'the Email section heading');
  await settle(page);
  await shot(page, 'settings-email');
});

test('settings-newsletters', async ({ page }) => {
  const heading = page.getByRole('heading', { name: 'Newsletters', level: 2, exact: true });
  await open(
    page,
    '/settings/notifications/newsletters',
    heading,
    'the Newsletters section heading'
  );
  await settle(page);
  await shot(page, 'settings-newsletters');
});

test('newsletter-editor', async ({ page }) => {
  const heading = page.getByRole('heading', { name: "What's new this week" });
  await open(
    page,
    `/settings/notifications/newsletters/${newsletterId}`,
    heading,
    'the newsletter name heading'
  );
  await settle(page);
  await shot(page, 'newsletter-editor');
});

test('newsletter-history', async ({ page }) => {
  const tab = page.getByRole('tab', { name: 'History' });
  await open(
    page,
    `/settings/notifications/newsletters/${newsletterId}?tab=history`,
    tab,
    'the History tab'
  );
  await settle(page);

  const openSend = page.getByRole('button', { name: /^Open the send from / }).first();
  await expect(openSend, 'no send row in the newsletter history').toBeVisible(READY);
  await openSend.click();

  const sheet = page.getByRole('dialog', { name: 'Send' });
  await expect(sheet, 'the send detail sheet did not open').toBeVisible(READY);
  await settle(page);
  await shot(page, 'newsletter-history');
});

test('digest-email', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 660, height: 1400 },
    deviceScaleFactor: 2,
    timezoneId: 'America/Denver',
    locale: 'en-US',
  });
  try {
    const page = await context.newPage();
    // The digest links its logo and posters relative to the instance.
    await page.setContent(digestHtml.replace('<head>', `<head><base href="${BASE_URL}/">`), {
      waitUntil: 'load',
    });
    await waitForImages(page);
    await page.waitForTimeout(CHART_SETTLE_MS);
    await writeWebp(await page.screenshot({ type: 'png' }), outPath('digest-email'));
  } finally {
    await context.close();
  }
});
