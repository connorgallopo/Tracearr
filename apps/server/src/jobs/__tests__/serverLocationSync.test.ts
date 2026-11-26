import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';

vi.mock('../../db/client.js', () => ({ db: { execute: vi.fn(), transaction: vi.fn() } }));

import { db } from '../../db/client.js';
import { renderSql } from '../../test/helpers.js';
import { syncLocationBatch } from '../serverLocationSync.js';
import { MAX_POINT_UPDATES_PER_PASS } from '../../db/timescale.js';
import type { LocationRange } from '../../services/serverLocationRanges.js';

const PLACED: LocationRange = {
  from: null,
  to: null,
  location: {
    effectiveFrom: null,
    lat: 41.8781,
    lon: -87.6298,
    city: 'Chicago',
    region: 'Illinois',
    country: 'US',
  },
};
const UNPLACED: LocationRange = { from: null, to: null, location: null };

/** The read runs on db. In the transaction, call 0 is the decompression-cap GUC probe; an empty result skips the SET LOCAL */
function mockTransaction(selectRows: unknown[]) {
  vi.mocked(db.execute).mockResolvedValue({ rows: selectRows } as never);
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  vi.mocked(db.transaction).mockImplementation((async (callback: (tx: unknown) => unknown) =>
    callback({ execute })) as never);
  return execute;
}

const rendered = (execute: ReturnType<typeof vi.fn>, call: number) =>
  renderSql(execute.mock.calls[call]?.[0] as SQL);
const selected = () => renderSql(vi.mocked(db.execute).mock.calls[0]?.[0] as SQL);
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

const localRow = (id: string, startedAt: string) => ({
  id,
  started_at: startedAt,
  server_user_id: 'user-1',
  server_id: 'server-1',
  ip_address: '192.168.1.5',
  is_local: true,
});
const chunk = (start: string, end: string) => [{ start: new Date(start), end: new Date(end) }];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('syncLocationBatch', () => {
  it('compares and writes coordinates as real so repeated runs converge', async () => {
    const execute = mockTransaction([
      {
        id: 'a',
        started_at: '2026-01-02 10:00:00.123456+00',
        ip_address: '192.168.1.5',
        is_local: true,
      },
    ]);
    await syncLocationBatch('server-1', PLACED, null, []);
    expect(rendered(execute, 0).sql).toContain('FROM pg_settings');
    const select = selected().sql;
    const update = rendered(execute, 1).sql;
    expect(select).toMatch(/geo_lat IS DISTINCT FROM \$\d+::real/);
    expect(select).toContain('s.geo_continent IS NOT NULL');
    expect(update).toMatch(/geo_lat = \$\d+::real/);
    expect(update).toContain('geo_continent = NULL');
  });

  it('writes the Local Network label and null coordinates when unplaced', async () => {
    const execute = mockTransaction([
      { id: 'a', started_at: '2026-01-02 10:00:00+00', ip_address: '10.0.0.4', is_local: true },
    ]);
    await syncLocationBatch('server-1', UNPLACED, null, []);
    const { sql: update, params } = rendered(execute, 1);
    expect(update).toContain('geo_lat = NULL::real');
    expect(params).toContain('Local Network');
  });

  it('only flags unclassified rows whose IP is public, leaving their geo alone', async () => {
    const execute = mockTransaction([
      {
        id: 'private',
        started_at: '2026-01-02 10:00:00+00',
        ip_address: '192.168.1.5',
        is_local: null,
      },
      { id: 'public', started_at: '2026-01-01 10:00:00+00', ip_address: '8.8.8.8', is_local: null },
    ]);
    const result = await syncLocationBatch('server-1', PLACED, null, []);
    expect(result.count).toBe(2);
    expect(rendered(execute, 1).sql).toContain("'private'::uuid");
    expect(rendered(execute, 1).sql).not.toContain("'public'::uuid");
    expect(rendered(execute, 2).sql).toContain('is_local = false');
    expect(rendered(execute, 2).sql).toContain("'public'::uuid");
  });

  it('bounds the update by the exact started_at text it selected', async () => {
    const execute = mockTransaction([
      {
        id: 'a',
        started_at: '2026-01-02 10:00:00.123456+00',
        ip_address: '192.168.1.5',
        is_local: true,
      },
      {
        id: 'b',
        started_at: '2026-01-01 09:00:00.654321+00',
        ip_address: '192.168.1.6',
        is_local: true,
      },
    ]);
    await syncLocationBatch('server-1', PLACED, null, []);
    expect(rendered(execute, 1).params).toEqual(
      expect.arrayContaining(['2026-01-01 09:00:00.654321+00', '2026-01-02 10:00:00.123456+00'])
    );
  });

  it('skips a window that does not overlap the range', async () => {
    const execute = mockTransaction([]);
    const range: LocationRange = { ...PLACED, from: new Date('2026-02-01T00:00:00Z') };
    const result = await syncLocationBatch(
      'server-1',
      range,
      {
        start: new Date('2026-01-01T00:00:00Z'),
        end: new Date('2026-01-15T00:00:00Z'),
      },
      []
    );
    expect(result).toEqual({ count: 0, oldest: null });
    expect(db.execute).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('opens no transaction when no row differs', async () => {
    mockTransaction([]);
    const result = await syncLocationBatch(
      'server-1',
      PLACED,
      null,
      chunk('2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z')
    );
    expect(result).toEqual({ count: 0, oldest: null });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("writes a batch over a compressed chunk by point updates on each row's constant key and segment", async () => {
    const execute = mockTransaction([
      localRow('private', '2026-01-02 10:00:00.123456+00'),
      {
        id: 'public',
        started_at: '2026-01-01 09:00:00+00',
        server_user_id: 'user-2',
        server_id: 'server-1',
        ip_address: '8.8.8.8',
        is_local: null,
      },
    ]);
    const result = await syncLocationBatch(
      'server-1',
      PLACED,
      null,
      chunk('2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z')
    );
    expect(result).toEqual({
      count: 2,
      oldest: new Date('2026-01-01T09:00:00Z'),
      cursor: '2026-01-01 09:00:00+00',
    });
    const place = rendered(execute, 1);
    expect(flat(place.sql)).toBe(
      'UPDATE sessions s SET is_local = true, geo_city = $1, geo_region = $2, geo_country = $3, geo_lat = $4::real, geo_lon = $5::real, geo_continent = NULL, geo_postal = NULL WHERE s.id = $6::uuid AND s.started_at = $7::timestamptz AND s.server_user_id = $8::uuid AND s.server_id = $9::uuid'
    );
    expect(place.params).toEqual([
      'Chicago',
      'Illinois',
      'US',
      41.8781,
      -87.6298,
      'private',
      '2026-01-02 10:00:00.123456+00',
      'user-1',
      'server-1',
    ]);
    const remote = rendered(execute, 2);
    expect(flat(remote.sql)).toBe(
      'UPDATE sessions s SET is_local = false WHERE s.id = $1::uuid AND s.started_at = $2::timestamptz AND s.server_user_id = $3::uuid AND s.server_id = $4::uuid'
    );
    expect(remote.params).toEqual(['public', '2026-01-01 09:00:00+00', 'user-2', 'server-1']);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('writes up to the point-update limit by point updates and one more by the batch statement', async () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => localRow(`r${i}`, '2026-01-02 10:00:00+00'));
    const compressed = chunk('2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z');

    const atLimit = mockTransaction(rows(MAX_POINT_UPDATES_PER_PASS));
    await syncLocationBatch('server-1', PLACED, null, compressed);
    expect(atLimit).toHaveBeenCalledTimes(1 + MAX_POINT_UPDATES_PER_PASS);

    const over = mockTransaction(rows(MAX_POINT_UPDATES_PER_PASS + 1));
    await syncLocationBatch('server-1', PLACED, null, compressed);
    expect(over).toHaveBeenCalledTimes(2);
    expect(rendered(over, 1).sql).toContain('id = ANY(');
  });

  it('writes by point updates only when a compressed chunk reaches the batch span', async () => {
    const batch = [
      localRow('a', '2026-01-02 10:00:00+00'),
      localRow('b', '2026-01-01 09:00:00+00'),
    ];
    const writes = async (compressed: ReturnType<typeof chunk>) => {
      const execute = mockTransaction(batch);
      await syncLocationBatch('server-1', PLACED, null, compressed);
      return execute.mock.calls.length - 1;
    };
    expect(await writes(chunk('2025-12-01T00:00:00Z', '2026-01-01T09:00:00Z'))).toBe(1);
    expect(await writes(chunk('2025-12-01T00:00:00Z', '2026-01-01T09:00:00.001Z'))).toBe(2);
    expect(await writes(chunk('2026-01-02T10:00:00Z', '2026-02-01T00:00:00Z'))).toBe(2);
    expect(await writes(chunk('2026-01-02T10:00:00.001Z', '2026-02-01T00:00:00Z'))).toBe(1);
  });
});
