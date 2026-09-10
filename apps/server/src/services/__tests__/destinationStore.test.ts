import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rows: Array<Record<string, unknown>> = [];
const mockPublish = vi.fn(() => Promise.resolve());
vi.mock('../cache.js', () => ({ getPubSubService: () => ({ publish: mockPublish }) }));
vi.mock('../../db/client.js', () => ({
  db: {
    // a query returns a fresh array, so the cached list does not track later pushes
    select: () => ({
      from: () => ({
        where: () => {
          const found = [...rows];
          return Object.assign(Promise.resolve(found), { limit: async () => found });
        },
        orderBy: async () => [...rows],
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          const r = { id: 'new', createdAt: new Date(), updatedAt: new Date(), ...v };
          rows.push(r);
          return [r];
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            Object.assign(rows[0] ?? {}, patch);
            return rows[0] ? [rows[0]] : [];
          },
        }),
      }),
    }),
    delete: () => ({ where: () => ({ returning: async () => rows.splice(0, 1) }) }),
  },
}));
vi.mock('../../db/schema.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
}));
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  initDestinationCrypto,
  encryptConfig,
  resetDestinationCryptoForTests,
} from '../notifications/destinationCrypto.js';
import {
  createDestination,
  findDestinationsForEvent,
  invalidateDestinationsCache,
  listDestinations,
  readConfig,
  toPublicDestination,
  updateDestination,
  type DestinationRow,
} from '../notifications/destinationStore.js';

const t = new Date();
const discord = (): DestinationRow => ({
  id: 'd1',
  name: 'Discord',
  type: 'discord',
  config: encryptConfig({ webhookUrl: 'https://d/hook' }),
  events: ['violation_detected', 'server_down'],
  enabled: true,
  builtin: false,
  configStatus: 'ok',
  createdAt: t,
  updatedAt: t,
});
const push = (): DestinationRow => ({
  id: 'p1',
  name: 'Mobile push',
  type: 'push',
  config: null,
  events: ['violation_detected'],
  enabled: true,
  builtin: true,
  configStatus: 'ok',
  createdAt: t,
  updatedAt: t,
});

describe('destinationStore', () => {
  const env = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    resetDestinationCryptoForTests();
    delete process.env.ENCRYPTION_KEY;
    process.env.JWT_SECRET = 'jwt';
    initDestinationCrypto();
    rows.length = 0;
    invalidateDestinationsCache();
  });
  afterEach(() => {
    process.env = { ...env };
    resetDestinationCryptoForTests();
  });

  it('caches the list and invalidates on write', async () => {
    rows.push(discord());
    expect((await listDestinations()).map((d) => d.id)).toEqual(['d1']);
    rows.push(push());
    expect((await listDestinations()).map((d) => d.id)).toEqual(['d1']); // cached
    invalidateDestinationsCache();
    expect((await listDestinations()).map((d) => d.id)).toEqual(['d1', 'p1']);
  });

  it('findDestinationsForEvent filters by events, enabled, and config status', async () => {
    rows.push(
      discord(),
      push(),
      { ...discord(), id: 'd2', name: 'off', enabled: false },
      { ...discord(), id: 'd3', name: 'stale', configStatus: 'reencrypt' }
    );
    const ids = (await findDestinationsForEvent('violation_detected')).map((d) => d.id);
    expect(ids).toEqual(['d1', 'p1']);
    expect((await findDestinationsForEvent('server_down')).map((d) => d.id)).toEqual(['d1']);
  });

  it('readConfig decrypts, returns null for built-ins, and reports bad blobs', () => {
    expect(readConfig(discord())).toEqual({
      ok: true,
      config: { webhookUrl: 'https://d/hook' },
      rewrap: false,
    });
    expect(readConfig(push())).toEqual({ ok: true, config: {}, rewrap: false });
    expect(readConfig({ ...discord(), config: 'v1:zzz' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('toPublicDestination masks secrets, lists which are set, and carries both reference counts', () => {
    const pub = toPublicDestination(discord(), 2, 3);
    expect(pub.config).toEqual({ webhookUrl: null });
    expect(pub.secretsSet).toEqual(['webhookUrl']);
    expect(pub.referencedByAutomationCount).toBe(2);
    expect(pub.referencedByNewsletterCount).toBe(3);
    expect(
      toPublicDestination({ ...discord(), configStatus: 'reencrypt' }, 0, 0).config
    ).toBeNull();
  });

  it('createDestination encrypts, publishes destinations:changed, and invalidates', async () => {
    const created = await createDestination({
      name: 'n',
      type: 'ntfy',
      config: { url: 'https://ntfy.sh', topic: 't' },
      events: ['server_up'],
      enabled: true,
    });
    expect(typeof created.config).toBe('string');
    expect(created.config).toMatch(/^v1:/);
    expect(mockPublish).toHaveBeenCalledWith('destinations:changed', expect.anything());
    expect((await listDestinations()).some((d) => d.id === 'new')).toBe(true);
  });

  it('toPublicDestination passes non-secret values through and returns null config for built-ins and unopenable blobs', () => {
    const ntfy: DestinationRow = {
      ...discord(),
      type: 'ntfy',
      config: encryptConfig({ url: 'https://n', topic: 'alerts', authToken: 'tok' }),
    };
    const pub = toPublicDestination(ntfy, 0, 0);
    expect(pub.config).toEqual({ url: null, topic: 'alerts', authToken: null });
    expect(pub.secretsSet).toEqual(['url', 'authToken']);
    expect(toPublicDestination(push(), 0, 0).config).toBeNull();
    expect(toPublicDestination({ ...discord(), config: 'v1:zzz' }, 0, 0).config).toBeNull();
  });

  it('toPublicDestination reports reencrypt for a stored-ok row that no longer opens', () => {
    const pub = toPublicDestination({ ...discord(), config: 'v1:zzz' }, 0, 0);
    expect(pub.configStatus).toBe('reencrypt');
    expect(pub.secretsSet).toEqual([]);
    expect(toPublicDestination(push(), 0, 0).configStatus).toBe('ok');
  });

  it('updateDestination keeps omitted secrets, clears null, replaces strings', async () => {
    rows.push({
      ...discord(),
      type: 'ntfy',
      config: encryptConfig({ url: 'https://a', topic: 't', authToken: 'tok' }),
    });
    const kept = await updateDestination('d1', { config: { topic: 'u' } });
    expect(readConfig(kept)).toMatchObject({
      ok: true,
      config: { url: 'https://a', topic: 'u', authToken: 'tok' },
    });
    const cleared = await updateDestination('d1', { config: { authToken: null } });
    expect(readConfig(cleared)).toMatchObject({
      ok: true,
      config: { url: 'https://a', topic: 'u' },
    });
  });
});
