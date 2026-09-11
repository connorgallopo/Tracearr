import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSql } from '../../../test/helpers.js';
import type { MediaScope } from '../../library/mediaDetailService.js';
import type { SQL } from 'drizzle-orm';

const { mockDb, watched } = vi.hoisted(() => ({
  mockDb: { execute: vi.fn() },
  watched: { resolveWatchedStates: vi.fn(), fetchEpisodeCounts: vi.fn() },
}));

vi.mock('../../../db/client.js', () => ({ db: mockDb }));
vi.mock('../../library/mediaWatchedService.js', () => watched);

import { listMediaRequests, listUserRequests } from '../reads.js';

const SHOW_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SERVER_ID = '33333333-3333-4333-8333-333333333333';
const SERVER_USER_ID = '44444444-4444-4444-8444-444444444444';

function showScope(): MediaScope {
  return { kind: 'show', aliases: [SHOW_ID], seasonNumber: null, showAliases: [] };
}

function seasonScope(): MediaScope {
  return { kind: 'season', aliases: [], seasonNumber: 2, showAliases: [SHOW_ID] };
}

function mediaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    server_id: SERVER_ID,
    media_id: SHOW_ID,
    media_type: 'show',
    status: 'completed',
    requested_at: '2026-01-01 00:00:00+00',
    available_at: '2026-01-01 00:00:05+00',
    deleted_at: null,
    seasons: [{ seasonNumber: 2, status: 'completed' }],
    is_4k: false,
    is_auto_request: false,
    remote_username: 'remote-person',
    server_user_id: SERVER_USER_ID,
    lens_user_id: USER_ID,
    user_server_id: SERVER_ID,
    username: 'matched-person',
    identity_name: 'Matched Person',
    thumb: 'https://example.com/a.png',
    ...overrides,
  };
}

function lastSql(index = 0): string {
  const call = mockDb.execute.mock.calls[index];
  if (!call) throw new Error(`execute was not called ${index + 1} time(s)`);
  return renderSql(call[0] as SQL)
    .sql.replace(/\s+/g, ' ')
    .trim();
}

describe('listMediaRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    watched.fetchEpisodeCounts.mockResolvedValue(new Map());
    watched.resolveWatchedStates.mockResolvedValue(new Map());
  });

  it('narrows a season scope to requests covering that season number', async () => {
    mockDb.execute.mockResolvedValue({ rows: [] });

    await listMediaRequests({ scope: seasonScope(), serverIds: undefined });

    const text = lastSql();
    expect(text).toContain('jsonb_array_elements');
    expect(text).toContain(`'seasonNumber'`);
    expect(text).toContain(SHOW_ID);
  });

  it('matches a show scope on the media id alone', async () => {
    mockDb.execute.mockResolvedValue({ rows: [] });

    await listMediaRequests({ scope: showScope(), serverIds: undefined });

    const text = lastSql();
    expect(text).not.toContain('jsonb_array_elements');
    expect(text).toContain('mr.media_id = ANY');
  });

  it('scopes to the servers the viewer can see', async () => {
    mockDb.execute.mockResolvedValue({ rows: [] });

    await listMediaRequests({ scope: showScope(), serverIds: [SERVER_ID] });

    expect(renderSql(mockDb.execute.mock.calls[0]![0] as SQL).params).toContain(SERVER_ID);
  });

  it('leaves an unmatched requester unwatched without probing', async () => {
    mockDb.execute.mockResolvedValue({
      rows: [
        mediaRow({
          id: 'req-unmatched',
          server_user_id: null,
          lens_user_id: null,
          user_server_id: null,
          username: null,
          identity_name: null,
          thumb: null,
        }),
      ],
    });

    const entries = await listMediaRequests({ scope: showScope(), serverIds: undefined });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.watchedState).toBe('unwatched');
    expect(entries[0]?.requester).toEqual({
      serverUserId: null,
      userId: null,
      serverId: SERVER_ID,
      username: 'remote-person',
      identityName: null,
      thumb: null,
    });
    expect(watched.resolveWatchedStates).not.toHaveBeenCalled();
    expect(watched.fetchEpisodeCounts).not.toHaveBeenCalled();
  });

  it('asks for the episode denominator once for every requester', async () => {
    const otherShowId = 'bbbbbbbb-1111-4111-8111-111111111111';
    mockDb.execute.mockResolvedValue({
      rows: [
        mediaRow(),
        mediaRow({
          id: 'req-2',
          media_id: otherShowId,
          server_user_id: '99999999-9999-4999-8999-999999999999',
          lens_user_id: '88888888-8888-4888-8888-888888888888',
        }),
      ],
    });

    await listMediaRequests({ scope: showScope(), serverIds: [SERVER_ID] });

    expect(watched.fetchEpisodeCounts).toHaveBeenCalledTimes(1);
    expect(watched.fetchEpisodeCounts).toHaveBeenCalledWith([SHOW_ID, otherShowId], [SERVER_ID]);
    expect(watched.resolveWatchedStates).toHaveBeenCalledTimes(2);
  });

  it('lenses a matched requester and computes the wait', async () => {
    mockDb.execute.mockResolvedValue({ rows: [mediaRow()] });
    watched.resolveWatchedStates.mockResolvedValue(new Map([[SHOW_ID, 'watched']]));

    const entries = await listMediaRequests({ scope: showScope(), serverIds: undefined });

    expect(entries[0]?.waitMs).toBe(5000);
    expect(entries[0]?.watchedState).toBe('watched');
    expect(entries[0]?.requester).toEqual({
      serverUserId: SERVER_USER_ID,
      userId: USER_ID,
      serverId: SERVER_ID,
      username: 'matched-person',
      identityName: 'Matched Person',
      thumb: 'https://example.com/a.png',
    });
    expect(watched.resolveWatchedStates).toHaveBeenCalledWith(
      expect.objectContaining({ lensUserId: USER_ID, showIds: [SHOW_ID], movieIds: [] })
    );
  });

  it('reports a null wait while nothing is available yet', async () => {
    mockDb.execute.mockResolvedValue({ rows: [mediaRow({ available_at: null })] });

    const entries = await listMediaRequests({ scope: showScope(), serverIds: undefined });

    expect(entries[0]?.waitMs).toBeNull();
  });
});

describe('listUserRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    watched.fetchEpisodeCounts.mockResolvedValue(new Map());
    watched.resolveWatchedStates.mockResolvedValue(new Map());
  });

  function summaryRow(overrides: Record<string, unknown> = {}) {
    return {
      total: 1,
      completed: 0,
      approved_or_completed: 0,
      decided: 0,
      median_wait_ms: null,
      ...overrides,
    };
  }

  it('leaves the approval rate null when nothing has been decided', async () => {
    mockDb.execute
      .mockResolvedValueOnce({
        rows: [{ ...mediaRow({ status: 'pending' }), title: 'X', year: 2020 }],
      })
      .mockResolvedValueOnce({ rows: [summaryRow()] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await listUserRequests({
      serverUserIds: [SERVER_USER_ID],
      serverIds: undefined,
      page: 2,
      pageSize: 5,
    });

    expect(result.summary).toEqual({
      total: 1,
      approvalRate: null,
      completed: 0,
      neverWatched: 0,
      medianWaitMs: null,
    });
    expect(result.total).toBe(1);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(5);
    expect(result.data[0]?.media).toEqual({
      mediaId: SHOW_ID,
      title: 'X',
      year: 2020,
      mediaType: 'show',
    });
  });

  it('divides approvals by decided requests', async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          summaryRow({
            total: 10,
            completed: 4,
            approved_or_completed: 6,
            decided: 8,
            median_wait_ms: 1500,
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await listUserRequests({
      serverUserIds: [SERVER_USER_ID],
      serverIds: undefined,
      page: 1,
      pageSize: 5,
    });

    expect(result.summary.approvalRate).toBeCloseTo(0.75);
    expect(result.summary.medianWaitMs).toBe(1500);
  });

  it('counts never-watched over every completed request, not just the page', async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [summaryRow({ total: 3, completed: 3, decided: 3 })] })
      .mockResolvedValueOnce({
        rows: [
          { id: 'c1', media_id: SHOW_ID, media_type: 'show', lens_user_id: USER_ID },
          {
            id: 'c2',
            media_id: 'aaaaaaaa-1111-4111-8111-111111111111',
            media_type: 'movie',
            lens_user_id: USER_ID,
          },
          { id: 'c3', media_id: null, media_type: 'movie', lens_user_id: USER_ID },
        ],
      });
    watched.resolveWatchedStates.mockResolvedValue(new Map([[SHOW_ID, 'watched']]));

    const result = await listUserRequests({
      serverUserIds: [SERVER_USER_ID],
      serverIds: undefined,
      page: 1,
      pageSize: 5,
    });

    expect(result.summary.neverWatched).toBe(2);
  });

  it('probes watched state through the server scope it was handed', async () => {
    mockDb.execute
      .mockResolvedValueOnce({
        rows: [{ ...mediaRow(), title: 'X', year: 2020 }],
      })
      .mockResolvedValueOnce({ rows: [summaryRow()] })
      .mockResolvedValueOnce({ rows: [] });
    watched.resolveWatchedStates.mockResolvedValue(new Map([[SHOW_ID, 'partial']]));

    const result = await listUserRequests({
      serverUserIds: [SERVER_USER_ID],
      serverIds: [SERVER_ID],
      page: 1,
      pageSize: 5,
    });

    expect(watched.fetchEpisodeCounts).toHaveBeenCalledWith([SHOW_ID], [SERVER_ID]);
    expect(watched.resolveWatchedStates).toHaveBeenCalledWith(
      expect.objectContaining({ serverIds: [SERVER_ID] })
    );
    expect(result.data[0]?.watchedState).toBe('partial');
  });

  it('returns an empty page without querying when the identity has no accounts', async () => {
    const result = await listUserRequests({
      serverUserIds: [],
      serverIds: undefined,
      page: 1,
      pageSize: 5,
    });

    expect(result).toEqual({
      data: [],
      total: 0,
      page: 1,
      pageSize: 5,
      summary: {
        total: 0,
        approvalRate: null,
        completed: 0,
        neverWatched: 0,
        medianWaitMs: null,
      },
    });
    expect(mockDb.execute).not.toHaveBeenCalled();
  });
});
