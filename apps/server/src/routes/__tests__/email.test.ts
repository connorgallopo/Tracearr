import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type RouteOptions } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

const suppressions = vi.hoisted(() => ({
  listSuppressions: vi.fn(),
  addSuppression: vi.fn(),
  removeSuppression: vi.fn(),
}));
vi.mock('../../services/newsletters/suppressions.js', () => suppressions);
const mockVerify = vi.fn();
vi.mock('../../services/newsletters/links.js', () => ({
  UNSUBSCRIBE_TOKEN_MAX_LENGTH: 92,
  verifyUnsubscribeToken: (...a: unknown[]) => mockVerify(...a) as unknown,
}));
const store = vi.hoisted(() => ({ loadDelivery: vi.fn(), loadServerLinks: vi.fn() }));
vi.mock('../../services/newsletters/store.js', () => store);
const branding = vi.hoisted(() => ({
  getEmailBranding: vi.fn(),
  saveEmailBranding: vi.fn(),
}));
vi.mock('../../services/notifications/emailBranding.js', () => branding);

import { emailRoutes } from '../email.js';

const owner: AuthUser = { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
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
  await app.register(emailRoutes, { prefix: '/email' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  routes.length = 0;
  store.loadDelivery.mockResolvedValue({
    recipient: { id: 'r1', address: 'a@x.com', sendId: 'send-1' },
    send: { id: 'send-1' },
    newsletter: { id: 'n1', senderName: null, scope: { serverIds: ['s1'], libraries: [] } },
  });
  store.loadServerLinks.mockResolvedValue([
    { id: 's1', name: 'Base<ment', type: 'plex', url: 'http://plex', machineIdentifier: null },
  ]);
});

describe('suppressions', () => {
  it('lists, adds lowercased, and removes for the owner only', async () => {
    const app = await build(owner);
    suppressions.listSuppressions.mockResolvedValue([]);
    expect((await app.inject({ method: 'GET', url: '/email/suppressions' })).statusCode).toBe(200);
    const res = await app.inject({
      method: 'POST',
      url: '/email/suppressions',
      payload: { address: 'Gone@X.com' },
    });
    expect(res.statusCode).toBe(201);
    expect(suppressions.addSuppression).toHaveBeenCalledWith('gone@x.com', 'manual');
    suppressions.removeSuppression.mockResolvedValue(true);
    expect(
      (await app.inject({ method: 'DELETE', url: '/email/suppressions/gone%40x.com' })).statusCode
    ).toBe(204);
    suppressions.removeSuppression.mockResolvedValue(false);
    expect(
      (await app.inject({ method: 'DELETE', url: '/email/suppressions/nobody%40x.com' })).statusCode
    ).toBe(404);
    const anon = await build(null);
    expect((await anon.inject({ method: 'GET', url: '/email/suppressions' })).statusCode).toBe(401);
  });

  it('does not double-decode a percent sign in the local part', async () => {
    const app = await build(owner);
    suppressions.removeSuppression.mockResolvedValue(true);
    const res = await app.inject({
      method: 'DELETE',
      url: '/email/suppressions/foo%25bar%40x.com',
    });
    expect(res.statusCode).toBe(204);
    expect(suppressions.removeSuppression).toHaveBeenCalledWith('foo%bar@x.com');
  });
});

describe('public unsubscribe', () => {
  it('GET shows a confirmation page without the address and with the protective headers', async () => {
    const app = await build(null);
    mockVerify.mockReturnValue('r1');
    const res = await app.inject({ method: 'GET', url: '/email/unsubscribe/tok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'"
    );
    expect(res.body).toContain('<form method="post"');
    expect(res.body).not.toContain('a@x.com');
    expect(store.loadServerLinks).toHaveBeenCalledWith(['s1']);
    expect(res.body).toContain(
      'Unsubscribe this address from all newsletters sent by Base&lt;ment?'
    );
    expect(res.body).not.toContain('Base<ment');
    expect(suppressions.addSuppression).not.toHaveBeenCalled();
  });

  it('POST suppresses the recipient address with the send as source, and a repeat POST suppresses it again the same way', async () => {
    const app = await build(null);
    mockVerify.mockReturnValue('r1');
    const res = await app.inject({
      method: 'POST',
      url: '/email/unsubscribe/tok',
      payload: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(200);
    expect(suppressions.addSuppression).toHaveBeenCalledWith('a@x.com', 'unsubscribed', 'send-1');
    expect(res.body).toContain(
      'This address will not receive newsletters from Base&lt;ment again.'
    );
    expect(res.body).not.toContain('a@x.com');
    const again = await app.inject({ method: 'POST', url: '/email/unsubscribe/tok' });
    expect(again.statusCode).toBe(200);
    expect(suppressions.addSuppression).toHaveBeenLastCalledWith(
      'a@x.com',
      'unsubscribed',
      'send-1'
    );
  });

  it('names the newsletter sender when one is set', async () => {
    const app = await build(null);
    mockVerify.mockReturnValue('r1');
    store.loadDelivery.mockResolvedValue({
      recipient: { id: 'r1', address: 'a@x.com', sendId: 'send-1' },
      send: { id: 'send-1' },
      newsletter: { id: 'n1', senderName: 'Family Media', scope: { serverIds: [], libraries: [] } },
    });
    const res = await app.inject({ method: 'GET', url: '/email/unsubscribe/tok' });
    expect(res.body).toContain('sent by Family Media?');
  });

  it('answers 404 with the same page shape for a bad token or a missing recipient', async () => {
    const app = await build(null);
    mockVerify.mockReturnValue(null);
    let res = await app.inject({ method: 'GET', url: '/email/unsubscribe/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    mockVerify.mockReturnValue('r1');
    store.loadDelivery.mockResolvedValue(null);
    res = await app.inject({ method: 'POST', url: '/email/unsubscribe/tok' });
    expect(res.statusCode).toBe(404);
    expect(suppressions.addSuppression).not.toHaveBeenCalled();
  });

  it('both public routes carry a per-route rate limit', async () => {
    await build(null);
    const publicRoutes = routes.filter((r) => String(r.url).includes('/unsubscribe/'));
    expect(publicRoutes.length).toBeGreaterThanOrEqual(2);
    for (const r of publicRoutes) {
      expect((r.config as { rateLimit?: { max: number; timeWindow: string } }).rateLimit).toEqual({
        max: 60,
        timeWindow: '1 minute',
      });
    }
  });
});

describe('branding', () => {
  const block = {
    logo: { mode: 'tracearr' as const },
    accentColor: '#123456',
    footerText: null,
    postalAddress: null,
    mailtoUnsubscribe: true,
  };

  it('returns the stored block to the owner', async () => {
    branding.getEmailBranding.mockResolvedValue(block);
    const app = await build(owner);
    const res = await app.inject({ method: 'GET', url: '/email/branding' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(block);
  });

  it('saves a valid block with its defaults filled and returns it', async () => {
    branding.saveEmailBranding.mockImplementation(async (input: unknown) => input);
    const app = await build(owner);
    const res = await app.inject({
      method: 'PUT',
      url: '/email/branding',
      payload: { footerText: ' Family Media ', accentColor: '#123456' },
    });
    expect(res.statusCode).toBe(200);
    expect(branding.saveEmailBranding).toHaveBeenCalledWith({
      logo: { mode: 'tracearr' },
      accentColor: '#123456',
      footerText: 'Family Media',
      postalAddress: null,
      mailtoUnsubscribe: false,
    });
    expect(res.json().footerText).toBe('Family Media');
  });

  it('rejects an invalid block with the first issue', async () => {
    const app = await build(owner);
    const res = await app.inject({
      method: 'PUT',
      url: '/email/branding',
      payload: { accentColor: 'teal' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('hex color');
    expect(branding.saveEmailBranding).not.toHaveBeenCalled();
  });

  it('refuses the sender name the branding block no longer carries', async () => {
    const app = await build(owner);
    const res = await app.inject({
      method: 'PUT',
      url: '/email/branding',
      payload: { senderName: 'Family Media' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('senderName');
    expect(branding.saveEmailBranding).not.toHaveBeenCalled();
  });

  it('is owner only', async () => {
    const admin: AuthUser = {
      userId: randomUUID(),
      username: 'admin',
      role: 'admin',
      serverIds: [],
    };
    const app = await build(admin);
    expect((await app.inject({ method: 'GET', url: '/email/branding' })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'PUT', url: '/email/branding', payload: {} })).statusCode
    ).toBe(403);
    const anon = await build(null);
    expect((await anon.inject({ method: 'GET', url: '/email/branding' })).statusCode).toBe(401);
  });
});
