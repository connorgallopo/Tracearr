import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type RouteOptions } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

const store = vi.hoisted(() => ({
  listNewsletters: vi.fn(),
  getNewsletter: vi.fn(),
  createNewsletter: vi.fn(),
  updateNewsletter: vi.fn(),
  deleteNewsletter: vi.fn(),
  findOpenSend: vi.fn(),
  lastSend: vi.fn(),
  listSends: vi.fn(),
  getSend: vi.fn(),
  getSendByViewToken: vi.fn(),
  listRecipients: vi.fn(),
  resetFailedRecipients: vi.fn(),
  loadServerLinks: vi.fn(),
  lastWatermark: vi.fn(),
  toPublicNewsletter: vi.fn((row: { id: string; name: string }) => ({
    id: row.id,
    name: row.name,
  })),
  toSendSummary: vi.fn((row: { id: string }) => ({ id: row.id })),
  toRecipient: vi.fn((row: { id: string }) => ({ id: row.id })),
}));
vi.mock('../../services/newsletters/store.js', () => store);
const queue = vi.hoisted(() => ({
  upsertNewsletterSchedule: vi.fn(),
  removeNewsletterSchedule: vi.fn(),
  nextRunAt: vi.fn(async () => null),
  enqueueNewsletterRun: vi.fn(async () => 'run-1'),
  enqueueDeliveries: vi.fn(async (_s: string, ids: string[]) => ids.length),
  InvalidScheduleError: class InvalidScheduleError extends Error {},
}));
vi.mock('../../jobs/newsletterQueue.js', () => queue);
const mockDestination = vi.fn();
vi.mock('../../services/notifications/destinationStore.js', () => ({
  getDestination: (...a: unknown[]) => mockDestination(...a) as unknown,
}));
const mockSettings = vi.fn();
vi.mock('../../services/settings.js', () => ({
  getNetworkSettings: () => mockSettings() as unknown,
}));
const mockAssemble = vi.fn();
vi.mock('../../services/newsletters/assemble.js', () => ({
  assembleDigest: (...a: unknown[]) => mockAssemble(...a) as unknown,
}));
const mockResolve = vi.fn();
vi.mock('../../services/newsletters/recipients.js', () => ({
  resolveRecipients: (...a: unknown[]) => mockResolve(...a) as unknown,
}));
const mockBranding = vi.fn();
vi.mock('../../services/notifications/emailBranding.js', () => ({
  resolveEmailBranding: (...a: unknown[]) => mockBranding(...a) as unknown,
}));
vi.mock('../../services/notifications/emailLogo.js', () => ({
  readLogoPng: () => Buffer.from('png'),
}));

import { buildProxyUrl } from '../../services/imageProxy.js';
import { newsletterRoutes } from '../newsletters.js';

const owner: AuthUser = { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
const admin: AuthUser = { userId: randomUUID(), username: 'admin', role: 'admin', serverIds: [] };
const ID = '11111111-1111-4111-8111-111111111111';
const DEST = '22222222-2222-4222-8222-222222222222';
const SEND_ID = '5f0b3e3a-3f4e-4c46-9a5c-1d2f0d0f9d21';
const TOKEN = 'a'.repeat(43);
const snapshotSend = {
  id: SEND_ID,
  newsletterId: ID,
  viewToken: TOKEN,
  subject: 'Weekly digest',
  outcome: 'sent',
  html: '<p>Hi</p><img src="poster:m1" alt="Heat"><img src="cid:logo" alt="x"><p style="m"><a href="{{view_url}}">View in browser</a></p><p style="m"><a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
  posters: { m1: { serverId: 's1', thumbPath: '/t/1', version: 'v1' } },
};
const body = {
  name: 'Weekly',
  schedule: { kind: 'weekly', dayOfWeek: 5, time: '18:00' },
  timezone: 'UTC',
  destinationId: DEST,
};
const row = {
  id: ID,
  name: 'Weekly',
  enabled: true,
  destinationId: DEST,
  schedule: body.schedule,
  timezone: 'UTC',
  imageMode: 'auto',
  scope: { serverIds: [], libraryIds: [] },
  sections: {},
  recipients: { members: true, extraAddresses: [], excludeUserIds: [] },
  senderName: null,
  links: { tracearr: false },
  subject: 's',
  intro: null,
  outro: null,
  window: { kind: 'fixed', days: 7 },
  skipWhenEmpty: true,
};

const routes: RouteOptions[] = [];

async function build(user: AuthUser | null): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.addHook('onRoute', (route) => {
    routes.push(route);
  });
  app.decorate('requireOwner', async (request: unknown, reply: FastifyReply) => {
    if (!user) return reply.unauthorized('Login required');
    (request as { user: AuthUser }).user = user;
    if (user.role !== 'owner') await reply.forbidden('Owner access required');
  });
  await app.register(newsletterRoutes, { prefix: '/newsletters' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  routes.length = 0;
  mockBranding.mockResolvedValue({
    branding: { accentColor: '#123456', footerText: null, postalAddress: null },
    logo: { mode: 'tracearr' },
    mailtoUnsubscribe: false,
  });
  mockDestination.mockResolvedValue({ id: DEST, type: 'email', enabled: true, configStatus: 'ok' });
  mockSettings.mockResolvedValue({
    externalUrl: 'https://tracearr.example.com',
    trustProxy: false,
  });
  store.getNewsletter.mockResolvedValue(row);
  store.createNewsletter.mockResolvedValue(row);
  store.updateNewsletter.mockResolvedValue(row);
  store.lastSend.mockResolvedValue(null);
  store.findOpenSend.mockResolvedValue(null);
  store.listNewsletters.mockResolvedValue([row]);
});

describe('newsletter routes', () => {
  it('forbids non-owners everywhere', async () => {
    const app = await build(admin);
    for (const [method, url] of [
      ['GET', '/newsletters'],
      ['POST', '/newsletters'],
      ['GET', `/newsletters/${ID}`],
      ['PATCH', `/newsletters/${ID}`],
      ['DELETE', `/newsletters/${ID}`],
      ['POST', `/newsletters/${ID}/preview`],
      ['GET', `/newsletters/${ID}/recipients`],
      ['POST', `/newsletters/${ID}/test`],
      ['POST', `/newsletters/${ID}/send`],
      ['GET', `/newsletters/${ID}/sends`],
      ['GET', `/newsletters/${ID}/sends/${SEND_ID}`],
      ['GET', `/newsletters/${ID}/sends/${SEND_ID}/html`],
      ['POST', `/newsletters/${ID}/sends/${SEND_ID}/retry-failed`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        payload: method === 'POST' || method === 'PATCH' ? body : undefined,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('creates a newsletter, upserts its scheduler, and answers 201', async () => {
    const app = await build(owner);
    const res = await app.inject({ method: 'POST', url: '/newsletters', payload: body });
    expect(res.statusCode).toBe(201);
    expect(store.createNewsletter).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Weekly',
        destinationId: DEST,
        imageMode: 'auto',
        senderName: null,
        links: { tracearr: false },
        recipients: { members: true, extraAddresses: [], excludeUserIds: [] },
      })
    );
    expect(queue.upsertNewsletterSchedule).toHaveBeenCalledWith(row);
  });

  it('answers 409 when the name collides on create or on a rename', async () => {
    const duplicate = () => new Error('duplicate key value', { cause: { code: '23505' } });
    store.createNewsletter.mockRejectedValueOnce(duplicate());
    const app = await build(owner);
    const created = await app.inject({ method: 'POST', url: '/newsletters', payload: body });
    expect(created.statusCode).toBe(409);
    expect(created.json().message).toBe('A newsletter with that name already exists');
    expect(queue.upsertNewsletterSchedule).not.toHaveBeenCalled();

    store.updateNewsletter.mockRejectedValueOnce(duplicate());
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/newsletters/${ID}`,
      payload: { name: 'Taken' },
    });
    expect(renamed.statusCode).toBe(409);
    expect(renamed.json().message).toBe('A newsletter with that name already exists');
  });

  it('rejects a destination that is not an email kind and hosted images without an external url', async () => {
    const app = await build(owner);
    mockDestination.mockResolvedValue({
      id: DEST,
      type: 'discord',
      enabled: true,
      configStatus: 'ok',
    });
    expect(
      (await app.inject({ method: 'POST', url: '/newsletters', payload: body })).statusCode
    ).toBe(400);
    mockDestination.mockResolvedValue({
      id: DEST,
      type: 'email',
      enabled: true,
      configStatus: 'ok',
    });
    mockSettings.mockResolvedValue({ externalUrl: null, trustProxy: false });
    const res = await app.inject({
      method: 'POST',
      url: '/newsletters',
      payload: { ...body, imageMode: 'hosted' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/external url/i);
    expect(store.createNewsletter).not.toHaveBeenCalled();
  });

  it('rolls back a created row whose schedule the parser rejects', async () => {
    const app = await build(owner);
    queue.upsertNewsletterSchedule.mockRejectedValueOnce(new queue.InvalidScheduleError('bad'));
    store.deleteNewsletter.mockResolvedValue('deleted');
    const res = await app.inject({
      method: 'POST',
      url: '/newsletters',
      payload: { ...body, schedule: { kind: 'cron', expression: '99 99 * * *' } },
    });
    expect(res.statusCode).toBe(400);
    expect(store.deleteNewsletter).toHaveBeenCalledWith(ID);
  });

  it('patches and re-upserts, and removes the scheduler when disabled', async () => {
    const app = await build(owner);
    store.updateNewsletter.mockResolvedValue({ ...row, enabled: false });
    const res = await app.inject({
      method: 'PATCH',
      url: `/newsletters/${ID}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(store.updateNewsletter).toHaveBeenCalledWith(ID, { enabled: false });
    expect(queue.upsertNewsletterSchedule).toHaveBeenCalledWith({ ...row, enabled: false });
  });

  it('clearing destinationId to null skips validating a destination that no longer exists', async () => {
    const app = await build(owner);
    mockDestination.mockResolvedValue(null);
    store.updateNewsletter.mockResolvedValue({ ...row, destinationId: null });
    const res = await app.inject({
      method: 'PATCH',
      url: `/newsletters/${ID}`,
      payload: { destinationId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(store.updateNewsletter).toHaveBeenCalledWith(ID, { destinationId: null });
  });

  it('patches the sender name, the links toggle and a rich intro through the partial builder', async () => {
    const app = await build(owner);
    const intro = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
    };
    const res = await app.inject({
      method: 'PATCH',
      url: `/newsletters/${ID}`,
      payload: { senderName: ' Family Media ', links: { tracearr: true }, intro },
    });
    expect(res.statusCode).toBe(200);
    expect(store.updateNewsletter).toHaveBeenCalledWith(ID, {
      senderName: 'Family Media',
      links: { tracearr: true },
      intro,
    });
  });

  it('rejects a string intro and an unknown link key', async () => {
    const app = await build(owner);
    const text = await app.inject({
      method: 'PATCH',
      url: `/newsletters/${ID}`,
      payload: { intro: 'plain' },
    });
    expect(text.statusCode).toBe(400);
    expect(text.json().message).toMatch(/intro/);
    const links = await app.inject({
      method: 'PATCH',
      url: `/newsletters/${ID}`,
      payload: { links: { tracearr: true, imdb: false } },
    });
    expect(links.statusCode).toBe(400);
    expect(store.updateNewsletter).not.toHaveBeenCalled();
  });

  it('lists who the next send reaches, who has no address, and who is excluded', async () => {
    const app = await build(owner);
    const view = {
      recipients: [
        { address: 'a@x.com', userId: 'u1', serverUserId: 'su-1', name: 'One', suppressed: false },
      ],
      missing: [{ userId: 'u2', serverUserId: 'su-2', name: 'Two' }],
      excluded: [{ userId: 'u3', serverUserId: 'su-3', name: null }],
    };
    mockResolve.mockResolvedValue(view);
    const res = await app.inject({ method: 'GET', url: `/newsletters/${ID}/recipients` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(view);
    expect(mockResolve).toHaveBeenCalledWith(row);
    store.getNewsletter.mockResolvedValueOnce(null);
    expect(
      (await app.inject({ method: 'GET', url: `/newsletters/${ID}/recipients` })).statusCode
    ).toBe(404);
  });

  it('refuses to delete while a send is open, otherwise deletes and drops the scheduler', async () => {
    const app = await build(owner);
    store.deleteNewsletter.mockResolvedValueOnce('open_send');
    expect((await app.inject({ method: 'DELETE', url: `/newsletters/${ID}` })).statusCode).toBe(
      409
    );
    store.deleteNewsletter.mockResolvedValueOnce('deleted');
    expect((await app.inject({ method: 'DELETE', url: `/newsletters/${ID}` })).statusCode).toBe(
      204
    );
    expect(queue.removeNewsletterSchedule).toHaveBeenCalledWith(ID);
  });

  it('send now and test enqueue runs, and both answer 409 while a send is open', async () => {
    const app = await build(owner);
    let res = await app.inject({ method: 'POST', url: `/newsletters/${ID}/send` });
    expect(res.statusCode).toBe(202);
    expect(queue.enqueueNewsletterRun).toHaveBeenCalledWith({
      newsletterId: ID,
      trigger: 'manual',
    });
    res = await app.inject({
      method: 'POST',
      url: `/newsletters/${ID}/test`,
      payload: { address: 'Me@Example.com' },
    });
    expect(res.statusCode).toBe(202);
    expect(queue.enqueueNewsletterRun).toHaveBeenCalledWith({
      newsletterId: ID,
      trigger: 'test',
      testAddress: 'me@example.com',
    });
    store.findOpenSend.mockResolvedValue({ id: 'open' });
    queue.enqueueNewsletterRun.mockClear();
    expect((await app.inject({ method: 'POST', url: `/newsletters/${ID}/send` })).statusCode).toBe(
      409
    );
    const blocked = await app.inject({
      method: 'POST',
      url: `/newsletters/${ID}/test`,
      payload: { address: 'me@example.com' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toBe('A send is already in progress');
    expect(queue.enqueueNewsletterRun).not.toHaveBeenCalled();
  });

  it('preview renders without writing and reports counts and recipients', async () => {
    const app = await build(owner);
    store.lastWatermark.mockResolvedValue(null);
    store.loadServerLinks.mockResolvedValue([
      { id: 's1', name: 'Basement', type: 'plex', url: 'http://plex', machineIdentifier: null },
    ]);
    mockAssemble.mockResolvedValue({
      data: {
        movies: [
          {
            cardId: 'm1',
            serverId: 's1',
            serverName: 'Basement',
            serverType: 'plex',
            ratingKey: '1',
            mediaId: null,
            imdbId: null,
            thumbPath: '/t',
            title: 'Heat',
            year: 1995,
            genres: [],
            addedAt: new Date(),
          },
        ],
        shows: [],
        artists: [],
        mostWatched: [],
        counts: { movies: 1, shows: 0, episodes: 0, albums: 0, mostWatched: 0 },
        isEmpty: false,
      },
      posters: { m1: { serverId: 's1', thumbPath: '/t', version: 'v1' } },
    });
    mockResolve.mockResolvedValue({
      recipients: [
        { address: 'a@x.com', userId: null, name: null, suppressed: false },
        { address: 'b@x.com', userId: null, name: null, suppressed: true },
      ],
      missing: [
        { userId: 'u1', serverUserId: 'su-1', name: 'One' },
        { userId: 'u2', serverUserId: 'su-2', name: null },
      ],
      excluded: [],
    });
    const res = await app.inject({ method: 'POST', url: `/newsletters/${ID}/preview` });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.counts).toEqual({ movies: 1, shows: 0, episodes: 0, albums: 0, mostWatched: 0 });
    expect(json.recipients).toEqual({ resolved: 1, missingEmail: 2, suppressed: 1 });
    expect(json.html).toContain('src="/api/v1/images/proxy?server=s1');
    expect(json.html).toContain('Heat');
    expect(mockBranding).toHaveBeenCalledWith();
    expect(json.html).toContain('#123456');
    expect(json.html).toContain('src="/api/v1/images/logo"');
  });

  it('preview shows the owner logo url when the branding block carries one', async () => {
    mockBranding.mockResolvedValue({
      branding: { accentColor: '#123456', footerText: null, postalAddress: null },
      logo: { mode: 'url', url: 'https://x.test/l.png' },
      mailtoUnsubscribe: false,
    });
    const app = await build(owner);
    store.lastWatermark.mockResolvedValue(null);
    store.loadServerLinks.mockResolvedValue([]);
    mockAssemble.mockResolvedValue({
      data: {
        movies: [],
        shows: [],
        artists: [],
        mostWatched: [],
        counts: { movies: 0, shows: 0, episodes: 0, albums: 0, mostWatched: 0 },
        isEmpty: true,
      },
      posters: {},
    });
    mockResolve.mockResolvedValue({ recipients: [], missing: [], excluded: [] });
    const res = await app.inject({ method: 'POST', url: `/newsletters/${ID}/preview` });
    expect(res.statusCode).toBe(200);
    expect(res.json().html).toContain('src="https://x.test/l.png"');
  });

  it('lists sends with pagination and retries failed recipients', async () => {
    const app = await build(owner);
    store.listSends.mockResolvedValue({ rows: [{ id: SEND_ID }], total: 1 });
    let res = await app.inject({
      method: 'GET',
      url: `/newsletters/${ID}/sends?page=2&pageSize=10`,
    });
    expect(res.statusCode).toBe(200);
    expect(store.listSends).toHaveBeenCalledWith(ID, 2, 10);
    store.getSend.mockResolvedValue({
      id: SEND_ID,
      newsletterId: ID,
      html: '<p>x</p>',
      outcome: 'partial',
    });
    store.resetFailedRecipients.mockResolvedValue(['r1', 'r2']);
    res = await app.inject({
      method: 'POST',
      url: `/newsletters/${ID}/sends/${SEND_ID}/retry-failed`,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: 2 });
    expect(queue.enqueueDeliveries).toHaveBeenCalledWith(SEND_ID, ['r1', 'r2']);
    store.getSend.mockResolvedValue({
      id: SEND_ID,
      newsletterId: ID,
      html: null,
      outcome: 'partial',
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/newsletters/${ID}/sends/${SEND_ID}/retry-failed`,
        })
      ).statusCode
    ).toBe(409);
  });

  it('rejects a malformed send id before touching the store', async () => {
    const app = await build(owner);
    const res = await app.inject({ method: 'GET', url: `/newsletters/${ID}/sends/not-a-uuid` });
    expect(res.statusCode).toBe(400);
    expect(store.getSend).not.toHaveBeenCalled();
  });

  it('preview names the sender from the newsletter and falls back to the one scoped server', async () => {
    const app = await build(owner);
    store.lastWatermark.mockResolvedValue(null);
    store.loadServerLinks.mockResolvedValue([
      { id: 's1', name: 'Basement', type: 'plex', url: 'http://plex', machineIdentifier: null },
    ]);
    mockAssemble.mockResolvedValue({
      data: {
        movies: [],
        shows: [],
        artists: [],
        mostWatched: [],
        counts: { movies: 0, shows: 0, episodes: 0, albums: 0, mostWatched: 0 },
        isEmpty: true,
      },
      posters: {},
    });
    mockResolve.mockResolvedValue({ recipients: [], missing: [], excluded: [] });
    const fallback = await app.inject({ method: 'POST', url: `/newsletters/${ID}/preview` });
    expect(fallback.json().html).toContain('Sent by Tracearr for <!-- -->Basement');
    store.getNewsletter.mockResolvedValue({ ...row, senderName: 'Family Media' });
    const named = await app.inject({ method: 'POST', url: `/newsletters/${ID}/preview` });
    expect(named.json().html).toContain('Sent by Tracearr for <!-- -->Family Media');
  });
});

describe('public view', () => {
  it('serves the snapshot with relative images and inert footer lines', async () => {
    store.getSendByViewToken.mockResolvedValue(snapshotSend);
    const app = await build(null);
    const res = await app.inject({ method: 'GET', url: `/newsletters/view/${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(store.getSendByViewToken).toHaveBeenCalledWith(TOKEN);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; img-src 'self' https:; style-src 'unsafe-inline'"
    );
    expect(res.body).toContain(
      `src="${buildProxyUrl({ serverId: 's1', path: '/t/1', width: 360, height: 540, fallback: 'poster', version: 'v1' })}"`
    );
    expect(res.body).toContain('src="/api/v1/images/logo"');
    expect(res.body).not.toContain('{{');
    expect(res.body).not.toContain('View in browser');
    expect(res.body).toContain('Unsubscribe links are only in the email itself.');
  });

  it('answers one 404 page for a malformed, unknown, or pruned token', async () => {
    store.getSendByViewToken.mockResolvedValue(null);
    const app = await build(null);
    const malformed = await app.inject({ method: 'GET', url: '/newsletters/view/not-a-token' });
    const unknown = await app.inject({ method: 'GET', url: `/newsletters/view/${'b'.repeat(43)}` });
    store.getSendByViewToken.mockResolvedValue({ ...snapshotSend, html: null });
    const pruned = await app.inject({ method: 'GET', url: `/newsletters/view/${TOKEN}` });
    for (const res of [malformed, unknown, pruned]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(malformed.body);
      expect(res.headers['x-robots-tag']).toBe('noindex');
    }
    expect(store.getSendByViewToken).toHaveBeenCalledTimes(2);
  });

  it('is rate limited and unauthenticated', async () => {
    await build(null);
    const route = routes.find((r) => r.url === '/newsletters/view/:token' && r.method === 'GET');
    expect(route?.config).toEqual({ rateLimit: { max: 60, timeWindow: '1 minute' } });
    expect(route?.preHandler).toBeUndefined();
  });
});

describe('send html', () => {
  it('returns the subject and the browser snapshot to the owner', async () => {
    store.getSend.mockResolvedValue(snapshotSend);
    const app = await build(owner);
    const res = await app.inject({
      method: 'GET',
      url: `/newsletters/${ID}/sends/${SEND_ID}/html`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().subject).toBe('Weekly digest');
    expect(res.json().html).toContain('src="/api/v1/images/logo"');
    expect(res.json().html).not.toContain('{{');
  });

  it('answers 404 when the snapshot is pruned or the send belongs elsewhere', async () => {
    store.getSend.mockResolvedValue({ ...snapshotSend, html: null });
    const app = await build(owner);
    expect(
      (await app.inject({ method: 'GET', url: `/newsletters/${ID}/sends/${SEND_ID}/html` }))
        .statusCode
    ).toBe(404);
    store.getSend.mockResolvedValue({ ...snapshotSend, newsletterId: randomUUID() });
    expect(
      (await app.inject({ method: 'GET', url: `/newsletters/${ID}/sends/${SEND_ID}/html` }))
        .statusCode
    ).toBe(404);
  });
});
