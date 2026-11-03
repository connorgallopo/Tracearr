import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import type { AuthUser } from '@tracearr/shared';
import { renderSql } from '../../../test/helpers.js';

vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
    selectDistinct: vi.fn(),
  },
}));

vi.mock('../../requests/analytics.js', () => ({
  getRequestsAnalytics: vi.fn(),
}));

import { db } from '../../../db/client.js';
import { countedSession } from '../../../db/sessions/rules.js';
import { getRequestsAnalytics } from '../../requests/analytics.js';
import { queryPlaysOverTime } from '../../../routes/stats/queries.js';
import {
  buildIdentityPlaysSql,
  buildPeopleRowsSql,
  queryIdentityRangeStats,
  queryPeopleRanked,
  resolveIdentityWindow,
  resolvePeopleWindow,
  type PeopleWindow,
} from '../peopleStats.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OWNER: AuthUser = { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const render = (fragment: SQL) => normalize(renderSql(fragment).sql);
const executedSql = () =>
  vi.mocked(db.execute).mock.calls.map(([query]) => render(query as unknown as SQL));

const WEEK: PeopleWindow = {
  period: 'week',
  range: { start: new Date('2026-10-11T00:00:00Z'), end: new Date('2026-10-18T00:00:00Z') },
  prior: { start: new Date('2026-10-04T00:00:00Z'), end: new Date('2026-10-11T00:00:00Z') },
  timezone: 'UTC',
  now: new Date('2026-10-18T00:00:00Z'),
};

function identityPlaysText(serverUserIds = [A, B]) {
  return render(
    buildIdentityPlaysSql({
      serverUserIds,
      resolvedServerIds: undefined,
      start: WEEK.range.start,
      end: WEEK.range.end,
    })
  );
}

function peopleText(rank: Parameters<typeof buildPeopleRowsSql>[0]['rank']) {
  return render(
    buildPeopleRowsSql({
      resolvedServerIds: undefined,
      window: WEEK,
      rank,
      pageSize: 20,
      offset: 0,
      requests: [],
    })
  );
}

function orderClause(text: string) {
  return text.match(/.*ORDER BY (.*) LIMIT/)?.[1] ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);
});

describe('resolvePeopleWindow', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns a week preset into two 7-day windows of whole UTC days that meet at the current start', () => {
    const now = new Date('2026-10-18T16:30:00Z');
    vi.useFakeTimers({ now });
    const { range, prior } = resolvePeopleWindow({ period: 'week' }, now);

    expect(range).toEqual({
      start: new Date('2026-10-12T00:00:00Z'),
      end: new Date('2026-10-19T00:00:00Z'),
    });
    expect(prior).toEqual({
      start: new Date('2026-10-05T00:00:00Z'),
      end: new Date('2026-10-12T00:00:00Z'),
    });
  });

  it('starts a custom range at the UTC day start of its first day and ends after its last day', () => {
    const { range } = resolvePeopleWindow({
      period: 'custom',
      startDate: '2019-03-01T15:30:00Z',
      endDate: '2019-03-07T08:00:00Z',
    });

    expect(range).toEqual({
      start: new Date('2019-03-01T00:00:00Z'),
      end: new Date('2019-03-08T00:00:00Z'),
    });
  });
});

describe('resolveIdentityWindow', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('measures a week preset and its prior as equal exact windows that meet with no gap', () => {
    const now = new Date('2026-10-18T16:30:00Z');
    vi.useFakeTimers({ now });
    const { range, prior } = resolveIdentityWindow({ period: 'week' }, now);

    expect(range).toEqual({ start: new Date('2026-10-11T16:30:00Z'), end: now });
    expect(prior).toEqual({
      start: new Date('2026-10-04T16:30:00Z'),
      end: new Date('2026-10-11T16:30:00Z'),
    });
  });

  it('has no prior window for all time', () => {
    expect(resolveIdentityWindow({ period: 'all' }).prior).toBeNull();
  });
});

describe('buildIdentityPlaysSql', () => {
  it('counts plays as distinct counted chains over sessions for the given accounts', () => {
    const text = identityPlaysText();
    expect(text).toContain('FROM sessions s');
    expect(text).not.toContain('user_media_plays_daily');
    expect(text).toContain(
      'BOOL_OR((COALESCE(s.duration_ms, 0) >= 120000 OR s.watched)) AS counted'
    );
    expect(text).toContain('COUNT(DISTINCT chain_id) FILTER (WHERE counted)');
    expect(text).toContain(`server_user_id = ANY(ARRAY['${A}'::uuid,'${B}'::uuid])`);
  });

  it('folds a chain whose sessions straddle midnight into one row, grouped by chain alone', () => {
    const text = identityPlaysText();
    expect(text).toContain('COALESCE(s.reference_id, s.id) AS chain_id');
    expect(text).toMatch(/FROM sessions s WHERE .* GROUP BY 1 \)/);
    expect(text).not.toContain('time_bucket');
    expect(text).not.toContain('date_trunc');
  });

  it('derives finished and abandoned from the 0.85 threshold per chain, once per chain', () => {
    const text = identityPlaysText();
    expect(text).toContain(
      'SUM(CASE WHEN (COALESCE(s.duration_ms, 0) >= 120000 OR s.watched) THEN s.duration_ms ELSE 0 END) AS watched_ms'
    );
    expect(text).toContain('MAX(s.progress_ms) AS max_progress_ms');
    expect(text).toContain('MAX(s.total_duration_ms) AS content_duration_ms');
    expect(text).toContain(
      'COALESCE(max_progress_ms, 0) >= content_duration_ms * 0.85 OR watched_ms >= content_duration_ms * 0.85'
    );
    expect(text).toMatch(/COUNT\(\*\) FILTER \(WHERE counted AND content_duration_ms > 0 AND \(/);
    expect(text).toMatch(
      /COUNT\(\*\) FILTER \(WHERE counted AND content_duration_ms > 0 AND NOT \(/
    );
  });
});

describe('queryIdentityRangeStats', () => {
  it('computes bytes from bitrate and duration and transcodes from either decision', async () => {
    await queryIdentityRangeStats({
      serverUserIds: [A],
      resolvedServerIds: undefined,
      window: WEEK,
    });
    const sessionsTotals = executedSql().find((text) => text.includes('AS bytes'));
    expect(sessionsTotals).toContain(
      'SUM(COALESCE(s.bitrate, 0)::bigint * COALESCE(s.duration_ms, 0)::bigint) / 8'
    );
    expect(sessionsTotals).toContain(
      "(s.video_decision = 'transcode' OR s.audio_decision = 'transcode')"
    );
  });

  it('sums both accounts of a merged identity and only the anchor at default scope', async () => {
    await queryIdentityRangeStats({
      serverUserIds: [A, B],
      resolvedServerIds: undefined,
      window: WEEK,
    });
    const personal = executedSql().filter((text) => text.includes('= ANY('));
    expect(personal.length).toBeGreaterThan(0);
    for (const text of personal) {
      expect(text).toContain(A);
      expect(text).toContain(B);
    }

    vi.mocked(db.execute).mockClear();
    await queryIdentityRangeStats({
      serverUserIds: [A],
      resolvedServerIds: undefined,
      window: WEEK,
    });
    expect(executedSql().some((text) => text.includes(B))).toBe(false);
  });

  it('counts every media type in the person and server series, while /plays keeps its filter', async () => {
    await queryIdentityRangeStats({
      serverUserIds: [A],
      resolvedServerIds: undefined,
      window: WEEK,
    });
    const series = executedSql().filter(
      (text) => text.includes('FROM sessions') && !text.includes('FROM sessions s')
    );
    expect(series.length).toBeGreaterThan(0);
    for (const text of series) expect(text).not.toContain("media_type IN ('movie', 'episode')");

    vi.mocked(db.execute).mockClear();
    await queryPlaysOverTime({
      rangeStart: WEEK.range.start,
      timezone: 'UTC',
      bucketInterval: '1 day',
      serverFilter: sql``,
    });
    expect(executedSql()[0]).toContain("media_type IN ('movie', 'episode')");
  });

  it('counts active days and the range as the UTC dates the exact window touches', async () => {
    const now = new Date('2026-10-18T16:30:00Z');
    vi.useFakeTimers({ now });
    vi.mocked(db.execute).mockImplementation((async (query: SQL) =>
      render(query).includes('AS active_days')
        ? { rows: [{ local_days: ['2026-10-17'], active_days: 1 }] }
        : { rows: [] }) as never);

    const stats = await queryIdentityRangeStats({
      serverUserIds: [A],
      resolvedServerIds: undefined,
      window: resolveIdentityWindow({ period: 'week' }, now),
    });
    vi.useRealTimers();

    const days = executedSql().find((text) => text.includes('AS active_days'));
    expect(days).toContain("COUNT(DISTINCT (s.started_at AT TIME ZONE 'UTC')::date)");
    expect(days).toContain('(COALESCE(s.duration_ms, 0) >= 120000 OR s.watched)');
    expect(stats.activeDays).toBe(1);
    expect(stats.daysInRange).toBe(8);
  });

  it('counts a window that starts at UTC midnight as its whole days', async () => {
    const now = new Date('2026-10-18T00:00:00Z');
    vi.useFakeTimers({ now });
    const stats = await queryIdentityRangeStats({
      serverUserIds: [A],
      resolvedServerIds: undefined,
      window: resolveIdentityWindow({ period: 'week' }, now),
    });
    vi.useRealTimers();

    expect(stats.daysInRange).toBe(7);
  });

  it('divides the server average by people with a counted play, through server_users, not by accounts', async () => {
    await queryIdentityRangeStats({
      serverUserIds: [A],
      resolvedServerIds: undefined,
      window: WEEK,
    });
    const average = executedSql().find((text) => text.includes('su.user_id'));
    expect(average).toContain('JOIN server_users su ON su.id = s.server_user_id');
    expect(average).toContain(
      `NULLIF(COUNT(DISTINCT su.user_id) FILTER (WHERE ${countedSession('s')}), 0)`
    );
    expect(average).not.toContain('COUNT(DISTINCT server_user_id)');
  });

  it('computes the local share over every counted play in range, null with none', async () => {
    vi.mocked(db.execute).mockImplementation((async (query: SQL) =>
      render(query).includes('AS local_plays')
        ? { rows: [{ bytes: '0', avg_bitrate: null, plays: 17, transcodes: 0, local_plays: 2 }] }
        : { rows: [] }) as never);
    const stats = await queryIdentityRangeStats({
      serverUserIds: [A],
      resolvedServerIds: undefined,
      window: WEEK,
    });
    const totals = executedSql().find((text) => text.includes('AS local_plays'));
    expect(totals).toContain('s.is_local IS TRUE');
    expect(totals).not.toContain('LIMIT');
    expect(stats.localShare).toBe(11.8);

    vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);
    const empty = await queryIdentityRangeStats({
      serverUserIds: [A],
      resolvedServerIds: undefined,
      window: WEEK,
    });
    expect(empty.localShare).toBeNull();
  });

  it('returns a zero-filled prior series when the prior window has no rows', async () => {
    const stats = await queryIdentityRangeStats({
      serverUserIds: [A],
      resolvedServerIds: undefined,
      window: WEEK,
    });
    // A week buckets by 6 hours: 7 days of 4 buckets.
    expect(stats.priorPlaysByDay).toHaveLength(28);
    expect(stats.priorPlaysByDay[0]).toEqual({ date: '2026-10-04 00:00:00', count: 0 });
    expect(stats.priorPlaysByDay.every((point) => point.count === 0)).toBe(true);
    expect(stats.priorPlays).toBe(0);
    expect(stats.finishedRate).toBeNull();
  });

  it('fills an empty prior window with one zero point per bucket, the partial first one included', async () => {
    const window = resolveIdentityWindow(
      {
        period: 'custom',
        startDate: '2019-03-01T00:00:00Z',
        endDate: '2019-03-08T00:00:00Z',
        timezone: 'America/New_York',
      },
      new Date('2019-03-09T00:00:00Z')
    );
    // The custom end day is included, so the eight-day range gets an eight-day prior.
    expect(window.prior).toEqual({
      start: new Date('2019-02-21T00:00:00Z'),
      end: new Date('2019-03-01T00:00:00Z'),
    });

    const stats = await queryIdentityRangeStats({
      serverUserIds: [A],
      resolvedServerIds: undefined,
      window,
    });
    // Custom ranges bucket by Monday-aligned weeks; the prior opens Thursday 19:00 in New York.
    expect(stats.priorPlaysByDay).toEqual([
      { date: '2019-02-18 00:00:00', count: 0 },
      { date: '2019-02-25 00:00:00', count: 0 },
    ]);
  });
});

describe('people search', () => {
  it('escapes LIKE wildcards, so a search of _ matches a literal underscore', () => {
    const { sql: text, params } = renderSql(
      buildPeopleRowsSql({
        resolvedServerIds: undefined,
        window: WEEK,
        rank: 'plays',
        pageSize: 20,
        offset: 0,
        requests: [],
        search: '_',
      })
    );

    expect(normalize(text)).toContain('u.name ILIKE');
    expect(normalize(text)).toContain('msu.username ILIKE');
    expect(params).toContain('%\\_%');
    expect(params).not.toContain('%_%');
  });
});

describe('queryPeopleRanked', () => {
  it('counts plays, hours, data and transcodes from the same session chains, as the user page does', () => {
    const text = peopleText('plays');
    expect(text).not.toContain('user_media_plays_daily');
    expect(text).toContain('COALESCE(s.reference_id, s.id) AS chain_id');
    expect(text).toContain('GROUP BY a.user_id, COALESCE(s.reference_id, s.id)');
    expect(text).toContain('COUNT(*) FILTER (WHERE counted)::int AS plays');
    expect(text).toContain('COUNT(*) FILTER (WHERE transcoded)::int AS transcodes');
    expect(text).toContain('ROUND(100.0 * t.transcodes / NULLIF(t.plays, 0), 1)');
  });

  it('ranks people by each metric and keeps zero-play people last except for lastSeen', () => {
    expect(orderClause(peopleText('plays'))).toBe('(plays = 0), plays DESC, user_id');
    expect(orderClause(peopleText('hours'))).toBe('(plays = 0), watch_ms DESC, user_id');
    expect(orderClause(peopleText('data'))).toBe('(plays = 0), bytes DESC, user_id');
    expect(orderClause(peopleText('transcodes'))).toBe(
      '(plays = 0), transcode_share DESC NULLS LAST, transcodes DESC, user_id'
    );
    expect(orderClause(peopleText('requests'))).toBe(
      '(plays = 0), requests_watched DESC, requests DESC, user_id'
    );
    expect(orderClause(peopleText('lastSeen'))).toBe('last_play_at DESC NULLS LAST, user_id');
  });

  it('summary: topThreeShare is the top three plays over all counted plays, quietPeople counts last play older than 90 days', async () => {
    vi.mocked(getRequestsAnalytics).mockResolvedValue({ requesters: [] } as never);
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            total_people: 5,
            matched_people: 5,
            active_people: 4,
            total_plays: 20,
            top_three_plays: 15,
            total_transcodes: 8,
            top_transcoder_count: 6,
            quiet_people: 2,
          },
        ],
      } as never);

    const result = await queryPeopleRanked({
      authUser: OWNER,
      resolvedServerIds: undefined,
      window: WEEK,
      rank: 'plays',
      page: 1,
      pageSize: 20,
    });

    expect(result.summary).toEqual({
      activePeople: 4,
      totalPeople: 5,
      topThreeShare: 75,
      topTranscoderShare: 75,
      topTranscoderCount: 6,
      totalTranscodes: 8,
      quietPeople: 2,
      quietDays: 90,
    });
    expect(result.meta).toEqual({ page: 1, pageSize: 20, total: 5 });
    const summarySql = executedSql()[1] ?? '';
    expect(summarySql).toContain('ORDER BY plays DESC LIMIT 3');
    expect(summarySql).toContain('last_play_at <');
    expect(
      renderSql(vi.mocked(db.execute).mock.calls[1]?.[0] as unknown as SQL).params
    ).toContainEqual(new Date('2026-07-20T00:00:00Z'));
  });
});
