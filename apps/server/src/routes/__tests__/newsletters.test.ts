import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type RouteOptions } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import { DEFAULT_NEWSLETTER_SECTIONS, type AuthUser } from '@tracearr/shared';

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
  getSnapshot: vi.fn(),
  getSnapshotByViewToken: vi.fn(),
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
vi.mock('../../services/newsletters/assemble.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/newsletters/assemble.js')>();
  return {
    sectionItemCounts: actual.sectionItemCounts,
    groupDigest: actual.groupDigest,
    assembleDigest: (...a: unknown[]) => mockAssemble(...a) as unknown,
  };
});
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
import {
  EXTERNAL_URL,
  JELLYFIN_SERVER,
  heaviestDigest,
  heaviestRuns,
} from '../../services/newsletters/__tests__/heaviestDigest.js';

const owner: AuthUser = { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
const admin: AuthUser = { userId: randomUUID(), username: 'admin', role: 'admin', serverIds: [] };
const ID = '11111111-1111-4111-8111-111111111111';
const DEST = '22222222-2222-4222-8222-222222222222';
const SEND_ID = '5f0b3e3a-3f4e-4c46-9a5c-1d2f0d0f9d21';
const TOKEN = 'a'.repeat(43);
const sentSend = {
  id: SEND_ID,
  newsletterId: ID,
  outcome: 'sent',
  hasSnapshot: true,
  variants: [
    {
      key: 's1',
      serverIds: ['s1'],
      serverNames: ['Basement'],
      recipientCount: 1,
      trimmed: { movies: 0, shows: 0, albums: 0, mostWatched: 0 },
      bytes: 100,
      empty: false,
    },
  ],
};
const snapshot = {
  sendId: SEND_ID,
  variantKey: 's1',
  viewToken: TOKEN,
  subject: 'Weekly digest',
  html: '<p>Hi</p><img src="poster:m1" alt="Heat"><img src="cid:logo" alt="x"><p style="m"><a href="{{view_url}}">View in browser</a></p><p style="m"><a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
  text: 'Hi',
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
  scope: { serverIds: [], libraries: [] },
  sections: DEFAULT_NEWSLETTER_SECTIONS,
  recipients: { members: true, extraAddresses: [], excludeUserIds: [] },
  senderName: null,
  links: { tracearr: false },
  subject: 's',
  intro: null,
  outro: null,
  window: { kind: 'fixed', days: 7 },
  skipWhenEmpty: true,
};

const S1 = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Basement',
  type: 'plex',
  url: 'http://plex',
  machineIdentifier: null,
  publicUrl: null,
};
const S2 = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Attic',
  type: 'jellyfin',
  url: 'http://jf',
  machineIdentifier: null,
  publicUrl: null,
};
const empty = {
  movies: [],
  shows: [],
  artists: [],
  mostWatched: [],
  counts: { movies: 0, shows: 0, episodes: 0, albums: 0, mostWatched: 0 },
  isEmpty: true,
};
const movie = (cardId: string, serverId: string, title: string) => ({
  ...empty,
  movies: [
    {
      cardId,
      serverId,
      serverName: '',
      serverType: 'plex',
      ratingKey: '1',
      mediaId: null,
      imdbId: null,
      thumbPath: null,
      mirrors: [],
      title,
      year: 2000,
      genres: [],
      addedAt: new Date(),
    },
  ],
  counts: { ...empty.counts, movies: 1 },
  isEmpty: false,
});
/** Basement has Heat, Attic has nothing new, the union has Heat. */
function twoServerScope() {
  store.lastWatermark.mockResolvedValue(null);
  store.loadServerLinks.mockResolvedValue([S2, S1]);
  mockAssemble.mockImplementation(async (nl: { scope: { serverIds: string[] } }) => {
    const ids = nl.scope.serverIds;
    if (ids.length === 1 && ids[0] === S2.id) return { data: empty, posters: {} };
    return { data: movie('m1', S1.id, 'Heat'), posters: {} };
  });
  mockResolve.mockResolvedValue({
    recipients: [
      { address: 'ann@x.com', userId: 'u1', serverIds: [S1.id], name: null, suppressed: false },
      { address: 'bob@x.com', userId: 'u2', serverIds: [S2.id], name: null, suppressed: false },
      { address: 'gone@x.com', userId: 'u3', serverIds: [S2.id], name: null, suppressed: true },
    ],
    missing: [],
    excluded: [],
  });
}

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
      ['POST', '/newsletters/preview'],
      ['GET', `/newsletters/${ID}/recipients`],
      ['GET', `/newsletters/${ID}/variants`],
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

  it('stores library scope as server and library pairs and refuses the bare id list', async () => {
    const app = await build(owner);
    const scope = {
      serverIds: [],
      libraries: [{ serverId: '33333333-3333-4333-8333-333333333333', libraryId: '1' }],
    };
    const created = await app.inject({
      method: 'POST',
      url: '/newsletters',
      payload: { ...body, scope },
    });
    expect(created.statusCode).toBe(201);
    expect(store.createNewsletter).toHaveBeenCalledWith(expect.objectContaining({ scope }));
    const res = await app.inject({
      method: 'PATCH',
      url: `/newsletters/${ID}`,
      payload: { scope },
    });
    expect(res.statusCode).toBe(200);
    expect(store.updateNewsletter).toHaveBeenCalledWith(ID, { scope });
    const old = await app.inject({
      method: 'PATCH',
      url: `/newsletters/${ID}`,
      payload: { scope: { serverIds: [], libraryIds: ['1'] } },
    });
    expect(old.statusCode).toBe(400);
    expect(old.json().message).toMatch(/libraryIds/);
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
        {
          address: 'a@x.com',
          userId: 'u1',
          serverUserId: 'su-1',
          name: 'One',
          suppressed: false,
          username: 'one',
          serverId: 's1',
          serverName: 'Basement Plex',
          serverIds: ['s1'],
          thumbUrl: null,
        },
        {
          address: 'extra@x.com',
          userId: null,
          serverUserId: null,
          name: 'Extra',
          suppressed: false,
          username: null,
          serverId: null,
          serverName: null,
          serverIds: [],
          thumbUrl: null,
        },
      ],
      missing: [
        {
          userId: 'u2',
          serverUserId: 'su-2',
          name: 'Two',
          username: 'two',
          serverId: 's1',
          serverName: 'Basement Plex',
          serverIds: ['s1'],
          thumbUrl: null,
        },
      ],
      excluded: [
        {
          userId: 'u3',
          serverUserId: 'su-3',
          name: null,
          username: 'three',
          serverId: 's1',
          serverName: 'Basement Plex',
          serverIds: ['s1'],
          thumbUrl: null,
          reason: 'excluded',
        },
      ],
    };
    mockResolve.mockResolvedValue(view);
    const res = await app.inject({ method: 'GET', url: `/newsletters/${ID}/recipients` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(view);
    const [member, extra] = res.json().recipients;
    expect(member).toMatchObject({ username: 'one', serverName: 'Basement Plex' });
    expect(extra).toMatchObject({
      username: null,
      serverId: null,
      serverName: null,
      thumbUrl: null,
    });
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
            mirrors: [],
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
        { address: 'a@x.com', userId: null, serverIds: ['s1'], name: null, suppressed: false },
        { address: 'b@x.com', userId: null, serverIds: ['s1'], name: null, suppressed: true },
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
    expect(json.variants[0].counts).toEqual({
      movies: 1,
      shows: 0,
      episodes: 0,
      albums: 0,
      mostWatched: 0,
    });
    expect(json.recipients).toEqual({ resolved: 1, missingEmail: 2, suppressed: 1 });
    expect(json.variants[0].trimmed).toEqual({ movies: 0, shows: 0, albums: 0, mostWatched: 0 });
    expect(json.variants[0].html).toContain('Unsubscribe links are only in the email itself.');
    expect(json.variants[0].html).not.toContain('{{unsubscribe_url}}');
    expect(json.variants[0].html).not.toContain('rel="preload"');
    expect(json.variants[0].html).toContain('src="/api/v1/images/proxy?server=s1');
    expect(json.variants[0].html).toContain('Heat');
    expect(mockBranding).toHaveBeenCalledWith();
    expect(json.variants[0].html).toContain('#123456');
    expect(json.variants[0].html).toContain('src="/api/v1/images/logo"');
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
    expect(res.json().variants[0].html).toContain('src="https://x.test/l.png"');
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
      hasSnapshot: true,
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
      hasSnapshot: false,
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
    expect(fallback.json().variants[0].html).toContain('Sent by Tracearr for <!-- -->Basement');
    store.getNewsletter.mockResolvedValue({ ...row, senderName: 'Family Media' });
    const named = await app.inject({ method: 'POST', url: `/newsletters/${ID}/preview` });
    expect(named.json().variants[0].html).toContain('Sent by Tracearr for <!-- -->Family Media');
  });

  it('preview trims the way a send would and reports what it removed', async () => {
    const app = await build(owner);
    store.lastWatermark.mockResolvedValue(null);
    store.loadServerLinks.mockResolvedValue([JELLYFIN_SERVER]);
    store.getNewsletter.mockResolvedValue({
      ...row,
      imageMode: 'hosted',
      links: { tracearr: true },
      intro: heaviestRuns(),
      outro: heaviestRuns(),
    });
    mockSettings.mockResolvedValue({ externalUrl: EXTERNAL_URL, trustProxy: false });
    mockBranding.mockResolvedValue({
      branding: {
        accentColor: '#123456',
        footerText: 'f'.repeat(500),
        postalAddress: 'p'.repeat(500),
      },
      logo: { mode: 'tracearr' },
      mailtoUnsubscribe: false,
    });
    mockAssemble.mockResolvedValue(heaviestDigest());
    mockResolve.mockResolvedValue({ recipients: [], missing: [], excluded: [] });
    const res = await app.inject({ method: 'POST', url: `/newsletters/${ID}/preview` });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    // Measured 2026-09-07: album covers and most-watched posters tie movies, shows and
    // albums at 12 items each, so the largest-section trim interleaves all three.
    expect(json.variants[0].trimmed).toEqual({ movies: 2, shows: 3, albums: 2, mostWatched: 0 });
    expect(json.variants[0].counts).toEqual({
      movies: 30,
      shows: 20,
      episodes: 1320,
      albums: 20,
      mostWatched: 10,
    });
    expect(json.variants[0].html).toContain('+11 more shows');
    expect(json.variants[0].html).toContain('src="/api/v1/images/proxy?server=');
    expect(json.variants[0].html).not.toContain('poster:');
  });

  it('preview returns one variant per membership set with the union first, its recipient counts and an empty one for a server with nothing new', async () => {
    twoServerScope();
    const app = await build(owner);
    const res = await app.inject({ method: 'POST', url: `/newsletters/${ID}/preview` });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.recipients).toEqual({ resolved: 2, missingEmail: 0, suppressed: 1 });
    expect(
      json.variants.map(
        (v: {
          key: string;
          serverNames: string[];
          recipientCount: number;
          counts: { movies: number };
        }) => [v.key, v.serverNames, v.recipientCount, v.counts.movies]
      )
    ).toEqual([
      // The scope names no server, so the union follows loadServerLinks' name order while its key sorts by id.
      // Nobody is on both servers, so the union carries no recipients; bob (Attic-only) lands in the Attic group.
      [`${S1.id},${S2.id}`, ['Attic', 'Basement'], 0, 1],
      [S1.id, ['Basement'], 1, 1],
      [S2.id, ['Attic'], 1, 0],
    ]);
    expect(json.variants[1].html).toContain('Heat');
    expect(json.variants[2].html).toContain('Nothing was added to <!-- -->Attic<!-- --> between');
    expect(json.variants[1].subject).toMatch(/^s$/);
  });

  it('test send carries the picked variant to the run and refuses one outside the newsletter', async () => {
    store.loadServerLinks.mockResolvedValue([S1, S2]);
    const app = await build(owner);
    const res = await app.inject({
      method: 'POST',
      url: `/newsletters/${ID}/test`,
      payload: { address: 'me@example.com', variantKey: S2.id },
    });
    expect(res.statusCode).toBe(202);
    expect(queue.enqueueNewsletterRun).toHaveBeenCalledWith({
      newsletterId: ID,
      trigger: 'test',
      testAddress: 'me@example.com',
      variantKey: S2.id,
    });
    const outside = await app.inject({
      method: 'POST',
      url: `/newsletters/${ID}/test`,
      payload: { address: 'me@example.com', variantKey: '33333333-3333-4333-8333-333333333333' },
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.json().message).toBe('variantKey names a server outside this newsletter');
  });

  it('lists the variants of the next send with their counts, without rendering or warming posters', async () => {
    twoServerScope();
    const app = await build(owner);
    const res = await app.inject({ method: 'GET', url: `/newsletters/${ID}/variants` });
    expect(res.statusCode).toBe(200);
    expect(res.json().variants).toEqual([
      {
        key: `${S1.id},${S2.id}`,
        serverIds: [S2.id, S1.id],
        serverNames: ['Attic', 'Basement'],
        recipientCount: 0,
        counts: { movies: 1, shows: 0, episodes: 0, albums: 0, mostWatched: 0 },
        isEmpty: false,
      },
      {
        key: S1.id,
        serverIds: [S1.id],
        serverNames: ['Basement'],
        recipientCount: 1,
        counts: { movies: 1, shows: 0, episodes: 0, albums: 0, mostWatched: 0 },
        isEmpty: false,
      },
      {
        key: S2.id,
        serverIds: [S2.id],
        serverNames: ['Attic'],
        recipientCount: 1,
        counts: { movies: 0, shows: 0, episodes: 0, albums: 0, mostWatched: 0 },
        isEmpty: true,
      },
    ]);
    for (const call of mockAssemble.mock.calls) expect(call[2]).toEqual({ posters: false });
    expect(mockBranding).not.toHaveBeenCalled();
  });

  it('preview from a draft body renders every variant the way a saved row does and writes no row', async () => {
    twoServerScope();
    const app = await build(owner);
    const res = await app.inject({
      method: 'POST',
      url: '/newsletters/preview',
      payload: { newsletter: { ...body, scope: { serverIds: [], libraries: [] } } },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.recipients).toEqual({ resolved: 2, missingEmail: 0, suppressed: 1 });
    expect(
      json.variants.map((v: { key: string; recipientCount: number }) => [v.key, v.recipientCount])
    ).toEqual([
      [`${S1.id},${S2.id}`, 0],
      [S1.id, 1],
      [S2.id, 1],
    ]);
    expect(json.variants[1].html).toContain('Heat');
    expect(json.window.fromWatermark).toBe(false);
    expect(store.createNewsletter).not.toHaveBeenCalled();
    expect(store.getNewsletter).not.toHaveBeenCalled();
  });

  it('preview from a draft starts at the saved row watermark when the id is given and at the fallback days without one', async () => {
    twoServerScope();
    const watermark = new Date(Date.now() - 2 * 86_400_000);
    store.lastWatermark.mockResolvedValue(watermark);
    const app = await build(owner);
    const draft = { ...body, window: { kind: 'since_last_send', fallbackDays: 3 } };
    const saved = await app.inject({
      method: 'POST',
      url: '/newsletters/preview',
      payload: { newsletterId: ID, newsletter: draft },
    });
    expect(saved.statusCode).toBe(200);
    expect(store.lastWatermark).toHaveBeenCalledWith(ID);
    expect(saved.json().window.start).toBe(watermark.toISOString());
    expect(saved.json().window.fromWatermark).toBe(true);

    const fresh = await app.inject({
      method: 'POST',
      url: '/newsletters/preview',
      payload: { newsletter: draft },
    });
    expect(fresh.statusCode).toBe(200);
    const lookback = Date.now() - new Date(fresh.json().window.start).getTime();
    expect(Math.abs(lookback - 3 * 86_400_000)).toBeLessThan(5_000);
    expect(fresh.json().window.fromWatermark).toBe(false);
  });

  it('preview reports fromWatermark false when the watermark is clamped to the window floor', async () => {
    store.getNewsletter.mockResolvedValue({
      ...row,
      window: { kind: 'since_last_send', fallbackDays: 3 },
    });
    store.lastWatermark.mockResolvedValue(new Date(Date.now() - 40 * 86_400_000));
    const app = await build(owner);
    const res = await app.inject({ method: 'POST', url: `/newsletters/${ID}/preview` });
    expect(res.statusCode).toBe(200);
    expect(res.json().window.fromWatermark).toBe(false);
  });

  it('preview from a draft answers 404 when newsletterId names no row', async () => {
    store.getNewsletter.mockResolvedValue(null);
    const app = await build(owner);
    const res = await app.inject({
      method: 'POST',
      url: '/newsletters/preview',
      payload: { newsletterId: ID, newsletter: body },
    });
    expect(res.statusCode).toBe(404);
    expect(store.lastWatermark).not.toHaveBeenCalled();
  });

  it('preview from a draft refuses a non-email destination and a bad body the way create does', async () => {
    mockDestination.mockResolvedValue({ id: DEST, type: 'discord', enabled: true });
    const app = await build(owner);
    const wrongKind = await app.inject({
      method: 'POST',
      url: '/newsletters/preview',
      payload: { newsletter: body },
    });
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.json().message).toBe('destinationId must name an email destination');
    const bad = await app.inject({
      method: 'POST',
      url: '/newsletters/preview',
      payload: { newsletter: { ...body, name: '' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/^Invalid request body: /);
  });
});

describe('public view', () => {
  it('serves the snapshot with relative images and inert footer lines', async () => {
    store.getSnapshotByViewToken.mockResolvedValue(snapshot);
    const app = await build(null);
    const res = await app.inject({ method: 'GET', url: `/newsletters/view/${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(store.getSnapshotByViewToken).toHaveBeenCalledWith(TOKEN);
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
    store.getSnapshotByViewToken.mockResolvedValue(null);
    const app = await build(null);
    const malformed = await app.inject({ method: 'GET', url: '/newsletters/view/not-a-token' });
    const unknown = await app.inject({ method: 'GET', url: `/newsletters/view/${'b'.repeat(43)}` });
    for (const res of [malformed, unknown]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(malformed.body);
      expect(res.headers['x-robots-tag']).toBe('noindex');
    }
    expect(store.getSnapshotByViewToken).toHaveBeenCalledWith('b'.repeat(43));
    expect(store.getSnapshotByViewToken).not.toHaveBeenCalledWith('not-a-token');
  });

  it('is rate limited and unauthenticated', async () => {
    await build(null);
    const route = routes.find((r) => r.url === '/newsletters/view/:token' && r.method === 'GET');
    expect(route?.config).toEqual({ rateLimit: { max: 60, timeWindow: '1 minute' } });
    expect(route?.preHandler).toBeUndefined();
  });
});

describe('send html', () => {
  it('returns the first variant by default and the asked-for variant by key', async () => {
    store.getSend.mockResolvedValue(sentSend);
    store.getSnapshot.mockResolvedValue(snapshot);
    const app = await build(owner);
    const res = await app.inject({
      method: 'GET',
      url: `/newsletters/${ID}/sends/${SEND_ID}/html`,
    });
    expect(res.statusCode).toBe(200);
    expect(store.getSnapshot).toHaveBeenCalledWith(SEND_ID, 's1');
    expect(res.json().subject).toBe('Weekly digest');
    expect(res.json().html).toContain('src="/api/v1/images/logo"');
    expect(res.json().html).not.toContain('{{');

    const key = '11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222';
    await app.inject({
      method: 'GET',
      url: `/newsletters/${ID}/sends/${SEND_ID}/html?variant=${encodeURIComponent(key)}`,
    });
    expect(store.getSnapshot).toHaveBeenLastCalledWith(SEND_ID, key);
  });

  it('reaches the empty-keyed snapshot the migration wrote for a send with no variants', async () => {
    store.getSend.mockResolvedValue({ ...sentSend, variants: [] });
    store.getSnapshot.mockImplementation(async (_sendId: string, key: string) =>
      key === '' ? { ...snapshot, variantKey: '' } : null
    );
    const app = await build(owner);
    const res = await app.inject({
      method: 'GET',
      url: `/newsletters/${ID}/sends/${SEND_ID}/html`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().subject).toBe('Weekly digest');
    expect(res.json().html).toContain('src="/api/v1/images/logo"');
  });

  it('answers 404 when the snapshot is pruned or the send belongs elsewhere, and 400 for a malformed variant', async () => {
    store.getSend.mockResolvedValue(sentSend);
    store.getSnapshot.mockResolvedValue(null);
    const app = await build(owner);
    expect(
      (await app.inject({ method: 'GET', url: `/newsletters/${ID}/sends/${SEND_ID}/html` }))
        .statusCode
    ).toBe(404);
    store.getSend.mockResolvedValue({ ...sentSend, newsletterId: randomUUID() });
    expect(
      (await app.inject({ method: 'GET', url: `/newsletters/${ID}/sends/${SEND_ID}/html` }))
        .statusCode
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/newsletters/${ID}/sends/${SEND_ID}/html?variant=nope`,
        })
      ).statusCode
    ).toBe(400);
  });
});
