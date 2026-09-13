import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: { execute: vi.fn() },
}));

vi.mock('../../../db/client.js', () => ({ db: mockDb }));

import { getRequestsAnalytics } from '../analytics.js';

const MOVIE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_MOVIE_ID = '11111111-1111-4111-8111-222222222222';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SERVER_ID = '33333333-3333-4333-8333-333333333333';
const SERVER_USER_ID = '44444444-4444-4444-8444-444444444444';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    server_id: SERVER_ID,
    media_id: MOVIE_ID,
    media_type: 'movie',
    title: 'A Movie',
    year: 2024,
    requested_at: '2026-01-01 00:00:00+00',
    available_at: '2026-01-01 01:00:00+00',
    seasons: null,
    lens_user_id: USER_ID,
    remote_username: 'remote-person',
    server_user_id: SERVER_USER_ID,
    user_server_id: SERVER_ID,
    username: 'matched-person',
    identity_name: 'Matched Person',
    thumb: null,
    ...overrides,
  };
}

function size(mediaId: string, season: number | null, bytes: number) {
  return { media_id: mediaId, season, bytes: String(bytes) };
}

/** Call 0 is the request scan, call 1 the size index, call 2 the (request, viewer) play pairs. */
function mockQueries(
  rows: unknown[],
  sizes: unknown[] = [size(MOVIE_ID, null, 1000)],
  viewers: { request_id: string; viewer_user_id: string | null; watched: boolean }[] = []
) {
  mockDb.execute
    .mockResolvedValueOnce({ rows })
    .mockResolvedValueOnce({ rows: sizes })
    .mockResolvedValue({ rows: viewers });
}

describe('getRequestsAnalytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leaves a request Seerr calls available but Tracearr never matched out of the landed set', async () => {
    mockQueries([row(), row({ id: 'req-2', media_id: null })]);

    const result = await getRequestsAnalytics(undefined);

    expect(result.funnel.requested).toBe(2);
    expect(result.funnel.landed).toBe(1);
    expect(result.unplayed.length).toBe(1);
    expect(result.unplayed.map((row) => row.id)).toEqual(['req-1']);
  });

  it('keeps a title somebody played out of the reclaim list', async () => {
    mockQueries(
      [row(), row({ id: 'req-2', media_id: OTHER_MOVIE_ID })],
      [size(MOVIE_ID, null, 1000), size(OTHER_MOVIE_ID, null, 500)],
      [
        { request_id: 'req-2', viewer_user_id: null, watched: true },
        { request_id: 'req-2', viewer_user_id: 'viewer-a', watched: true },
      ]
    );

    const result = await getRequestsAnalytics(undefined);

    expect(result.funnel).toEqual({ requested: 2, landed: 2, watched: 1 });
    expect(result.unplayed.map((row) => row.id)).toEqual(['req-1']);
  });

  it('totals the disk across every unplayed row', async () => {
    const mediaIds = Array.from(
      { length: 60 },
      (_, i) => `${MOVIE_ID.slice(0, -2)}${String(i).padStart(2, '0')}`
    );
    mockQueries(
      mediaIds.map((mediaId, i) => row({ id: `req-${i}`, media_id: mediaId })),
      mediaIds.map((mediaId) => size(mediaId, null, 1000))
    );

    const result = await getRequestsAnalytics(undefined);

    expect(result.unplayed).toHaveLength(60);
    expect(result.unplayedBytes).toBe(60_000);
  });

  it('sorts the reclaim rows by the disk they hold', async () => {
    mockQueries(
      [row({ id: 'small' }), row({ id: 'large', media_id: OTHER_MOVIE_ID })],
      [size(MOVIE_ID, null, 10), size(OTHER_MOVIE_ID, null, 900)]
    );

    const result = await getRequestsAnalytics(undefined);

    expect(result.unplayed.map((row) => row.id)).toEqual(['large', 'small']);
  });

  it('charges a season request only the seasons it asked for', async () => {
    mockQueries(
      [
        row({
          id: 'req-s1',
          media_type: 'show',
          seasons: [{ seasonNumber: 1, status: 'completed' }],
        }),
        row({
          id: 'req-s2',
          media_type: 'show',
          seasons: [{ seasonNumber: 2, status: 'completed' }],
        }),
      ],
      [size(MOVIE_ID, 1, 300), size(MOVIE_ID, 2, 700), size(MOVIE_ID, 3, 900)]
    );

    const result = await getRequestsAnalytics(undefined);

    const bySeason = new Map(result.unplayed.map((r) => [r.id, r.fileSizeBytes]));
    expect(bySeason.get('req-s1')).toBe(300);
    expect(bySeason.get('req-s2')).toBe(700);
    expect(result.unplayedBytes).toBe(1000);
  });

  it('counts a season once when two requests cover it', async () => {
    mockQueries(
      [
        row({
          id: 'req-a',
          media_type: 'show',
          seasons: [
            { seasonNumber: 1, status: 'completed' },
            { seasonNumber: 2, status: 'completed' },
          ],
        }),
        row({
          id: 'req-b',
          media_type: 'show',
          seasons: [{ seasonNumber: 2, status: 'completed' }],
        }),
      ],
      [size(MOVIE_ID, 1, 300), size(MOVIE_ID, 2, 700)]
    );

    const result = await getRequestsAnalytics(undefined);

    expect(result.unplayedBytes).toBe(1000);
  });

  it('charges a whole-show request every season on disk', async () => {
    mockQueries(
      [row({ id: 'req-all', media_type: 'show', seasons: [] })],
      [size(MOVIE_ID, 1, 300), size(MOVIE_ID, 2, 700)]
    );

    const result = await getRequestsAnalytics(undefined);

    expect(result.unplayed[0]?.fileSizeBytes).toBe(1000);
  });

  it('counts a person once across their accounts on different servers', async () => {
    const otherServerId = '55555555-5555-4555-8555-555555555555';
    mockQueries([
      row(),
      row({
        id: 'req-2',
        server_id: otherServerId,
        user_server_id: otherServerId,
        server_user_id: '66666666-6666-4666-8666-666666666666',
      }),
    ]);

    const result = await getRequestsAnalytics(undefined);

    expect(result.requesters).toHaveLength(1);
    expect(result.requesters[0]).toMatchObject({ requested: 2, landed: 2 });
  });

  it('leaves a request with nothing on disk off the reclaim list', async () => {
    mockQueries(
      [row(), row({ id: 'req-2', media_id: OTHER_MOVIE_ID })],
      [size(MOVIE_ID, null, 1000)]
    );

    const result = await getRequestsAnalytics(undefined);

    expect(result.unplayed.map((r) => r.id)).toEqual(['req-1']);
  });

  it('reports the requester median wait over the requests that landed', async () => {
    mockQueries([
      row({ available_at: '2026-01-01 00:00:10+00' }),
      row({ id: 'req-2', media_id: OTHER_MOVIE_ID, available_at: '2026-01-01 00:00:30+00' }),
      row({ id: 'req-3', media_id: null, available_at: null }),
    ]);

    const result = await getRequestsAnalytics(undefined);

    expect(result.requesters[0]).toMatchObject({
      requested: 3,
      landed: 2,
      watched: 0,
      medianWaitMs: 20_000,
    });
  });

  it('counts the landed requests somebody else watched through', async () => {
    mockQueries(
      [row(), row({ id: 'req-2', media_id: OTHER_MOVIE_ID })],
      [size(MOVIE_ID, null, 1000), size(OTHER_MOVIE_ID, null, 500)],
      [
        { request_id: 'req-1', viewer_user_id: 'viewer-a', watched: true },
        { request_id: 'req-1', viewer_user_id: 'viewer-b', watched: true },
        { request_id: 'req-2', viewer_user_id: 'viewer-a', watched: true },
      ]
    );

    const result = await getRequestsAnalytics(undefined);

    expect(result.requesters[0]).toMatchObject({ landed: 2, watchedByOthers: 2 });
  });

  it('does not count the requester watching their own request as someone else', async () => {
    mockQueries([row()], undefined, [
      { request_id: 'req-1', viewer_user_id: USER_ID, watched: true },
    ]);

    const result = await getRequestsAnalytics(undefined);

    expect(result.requesters[0]).toMatchObject({ watchedByOthers: 0 });
  });

  it('keeps a request played before its files were removed out of the reclaim list', async () => {
    mockQueries(
      [row({ media_type: 'show', seasons: [{ seasonNumber: 8, status: 'completed' }] })],
      [],
      [{ request_id: 'req-1', viewer_user_id: USER_ID, watched: true }]
    );

    const result = await getRequestsAnalytics(undefined);

    expect(result.unplayed).toEqual([]);
    expect(result.unplayedBytes).toBe(0);
  });

  it('leaves a person nobody else watched at zero', async () => {
    mockQueries([row()]);

    const result = await getRequestsAnalytics(undefined);

    expect(result.requesters[0]).toMatchObject({ watchedByOthers: 0 });
  });

  it('keeps an unmatched requester under their remote username', async () => {
    mockQueries([row({ server_user_id: null, lens_user_id: null, user_server_id: null })]);

    const result = await getRequestsAnalytics(undefined);

    expect(result.requesters[0]?.requester).toEqual({
      serverUserId: null,
      userId: null,
      serverId: SERVER_ID,
      username: 'remote-person',
      identityName: null,
      thumb: null,
    });
  });
});
