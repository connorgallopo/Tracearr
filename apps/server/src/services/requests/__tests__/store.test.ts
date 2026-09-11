import { beforeEach, describe, expect, it, vi } from 'vitest';

interface DbChain {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  groupBy: ReturnType<typeof vi.fn>;
  then: ReturnType<typeof vi.fn>;
  rows: unknown[];
}

const { chain, mockPublish } = vi.hoisted(() => {
  const rows: unknown[] = [];
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'insert',
    'values',
    'update',
    'set',
    'delete',
    'returning',
    'groupBy',
  ]) {
    chain[name] = vi.fn(() => chain);
  }
  chain.then = vi.fn();
  return {
    chain: Object.assign(chain, { rows }),
    mockPublish: vi.fn().mockResolvedValue(undefined),
  };
}) as unknown as { chain: DbChain; mockPublish: ReturnType<typeof vi.fn> };

vi.mock('../../../db/client.js', () => ({ db: chain }));
vi.mock('../../cache.js', () => ({ getPubSubService: () => ({ publish: mockPublish }) }));
vi.mock('../../notifications/destinationCrypto.js', () => ({
  encryptConfig: vi.fn((config: Record<string, unknown>) => `enc:${JSON.stringify(config)}`),
  decryptConfig: vi.fn((blob: string) =>
    blob.startsWith('enc:')
      ? { ok: true, config: JSON.parse(blob.slice(4)), rewrap: false }
      : { ok: false, reason: 'no-key' }
  ),
}));

import {
  createRequestService,
  readApiKey,
  toPublicRequestService,
  type RequestServiceRow,
} from '../store.js';

function makeRow(overrides: Partial<RequestServiceRow> = {}): RequestServiceRow {
  return {
    id: 'svc-1',
    serverId: 'srv-1',
    type: 'seerr',
    name: 'Beckon Requests',
    url: 'http://seerr.local:5055',
    config: 'enc:{"apiKey":"k"}',
    configStatus: 'ok',
    enabled: true,
    remoteServerId: 'abc',
    version: 'develop-4fc2',
    syncCursor: null,
    lastCounts: null,
    lastSyncAt: null,
    lastFullSyncAt: null,
    lastSyncError: null,
    createdAt: new Date('2026-09-11T00:00:00Z'),
    updatedAt: new Date('2026-09-11T00:00:00Z'),
    ...overrides,
  };
}

describe('request service store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('encrypts the api key on create and never stores it in plain text', async () => {
    chain.returning.mockImplementationOnce(() => Promise.resolve([makeRow()]));
    await createRequestService({
      serverId: 'srv-1',
      type: 'seerr',
      name: 'Beckon Requests',
      url: 'http://seerr.local:5055',
      apiKey: 'k',
      remoteServerId: 'abc',
      version: 'develop-4fc2',
    });
    const values = chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.config).toBe('enc:{"apiKey":"k"}');
    expect(JSON.stringify(values)).not.toContain('"apiKey":"k"');
    expect(mockPublish).toHaveBeenCalledWith('requests:changed', { serviceId: 'svc-1' });
  });

  it('reads the key back and reports a failed decrypt', () => {
    expect(readApiKey(makeRow())).toEqual({ ok: true, apiKey: 'k' });
    expect(readApiKey(makeRow({ config: 'garbage' }))).toEqual({ ok: false });
  });

  it('public shape carries counts and no config', () => {
    const pub = toPublicRequestService(makeRow(), {
      requests: 3,
      unmatchedMedia: 1,
      unmatchedUsers: 0,
    });
    expect(pub).toMatchObject({ id: 'svc-1', counts: { requests: 3 } });
    expect(JSON.stringify(pub)).not.toContain('enc:');
    expect(pub.createdAt).toBe('2026-09-11T00:00:00.000Z');
  });
});
