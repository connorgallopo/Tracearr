import { describe, it, expect } from 'vitest';
import {
  buildAliasMapCte,
  buildMovieListQuery,
  buildShowListQuery,
  mapMovieWatchedRows,
  mapShowWatchedRows,
} from '../mediaWatchedService.js';
import { renderSql } from '../../../test/helpers.js';

describe('mapMovieWatchedRows', () => {
  it('marks a movie watched when the row says so', () => {
    const result = mapMovieWatchedRows(
      ['movie-1'],
      [{ canonical_id: 'movie-1', watched: true, has_plays: true }]
    );
    expect(result.get('movie-1')).toBe('watched');
  });

  it('marks a movie partial when there are plays but no completed watch', () => {
    const result = mapMovieWatchedRows(
      ['movie-1'],
      [{ canonical_id: 'movie-1', watched: false, has_plays: true }]
    );
    expect(result.get('movie-1')).toBe('partial');
  });

  it('marks a movie unwatched when the row has no plays', () => {
    const result = mapMovieWatchedRows(
      ['movie-1'],
      [{ canonical_id: 'movie-1', watched: false, has_plays: false }]
    );
    expect(result.get('movie-1')).toBe('unwatched');
  });

  it('marks a movie unwatched when there is no row at all', () => {
    const result = mapMovieWatchedRows(['movie-1'], []);
    expect(result.get('movie-1')).toBe('unwatched');
  });
});

describe('mapShowWatchedRows', () => {
  it('marks a show watched when every known episode has been watched', () => {
    const result = mapShowWatchedRows(
      ['show-1'],
      [{ canonical_id: 'show-1', eps_watched: 10, has_plays: true }],
      new Map([['show-1', 10]])
    );
    expect(result.get('show-1')).toBe('watched');
  });

  it('marks a show partial when some but not all known episodes are watched', () => {
    const result = mapShowWatchedRows(
      ['show-1'],
      [{ canonical_id: 'show-1', eps_watched: 3, has_plays: true }],
      new Map([['show-1', 10]])
    );
    expect(result.get('show-1')).toBe('partial');
  });

  it('marks a show partial when there are plays but zero completed episodes', () => {
    const result = mapShowWatchedRows(
      ['show-1'],
      [{ canonical_id: 'show-1', eps_watched: 0, has_plays: true }],
      new Map([['show-1', 10]])
    );
    expect(result.get('show-1')).toBe('partial');
  });

  it('marks a show unwatched when the known episode count is zero', () => {
    const result = mapShowWatchedRows(
      ['show-1'],
      [{ canonical_id: 'show-1', eps_watched: 0, has_plays: false }],
      new Map([['show-1', 0]])
    );
    expect(result.get('show-1')).toBe('unwatched');
  });

  it('marks a show unwatched when the episode count is unknown', () => {
    const result = mapShowWatchedRows(
      ['show-1'],
      [{ canonical_id: 'show-1', eps_watched: 10, has_plays: true }],
      new Map()
    );
    expect(result.get('show-1')).toBe('unwatched');
  });

  it('marks a show unwatched when there is no row at all', () => {
    const result = mapShowWatchedRows(['show-1'], [], new Map([['show-1', 10]]));
    expect(result.get('show-1')).toBe('unwatched');
  });
});

describe('buildAliasMapCte', () => {
  it('produces a single-hop union of the page ids and their merged losers', () => {
    const { sql: query } = renderSql(buildAliasMapCte(['id-1', 'id-2']));
    const normalized = query.replace(/\s+/g, ' ').trim();
    expect(normalized).toContain('WITH alias_map AS (');
    expect(normalized).toContain(
      'SELECT id AS canonical_id, id AS any_id FROM unnest(ARRAY[$1::uuid, $2::uuid]::uuid[]) AS t(id)'
    );
    expect(normalized).toContain('UNION ALL');
    expect(normalized).toContain(
      'SELECT m.merged_into_id, m.id FROM media m WHERE m.merged_into_id = ANY(ARRAY[$3::uuid, $4::uuid]::uuid[])'
    );
  });

  it('binds each id once per half of the union, in order', () => {
    const { params } = renderSql(buildAliasMapCte(['id-1', 'id-2']));
    expect(params).toEqual(['id-1', 'id-2', 'id-1', 'id-2']);
  });

  it('produces an empty array literal when given no ids', () => {
    const { sql: query } = renderSql(buildAliasMapCte([]));
    const normalized = query.replace(/\s+/g, ' ').trim();
    expect(normalized).toContain('unnest(ARRAY[]::uuid[]) AS t(id)');
    expect(normalized).toContain('ANY(ARRAY[]::uuid[])');
  });
});

describe('buildMovieListQuery', () => {
  const base = {
    kind: 'movie' as const,
    userId: null,
    serverIds: undefined,
    minState: 'watched' as const,
    pageSize: 100,
    cursorValue: null,
  };
  const render = (overrides = {}) =>
    renderSql(buildMovieListQuery({ ...base, ...overrides }))
      .sql.replace(/\s+/g, ' ')
      .trim();

  it('guards on the media type so episode rows never enter the movie list', () => {
    const { sql: query, params } = renderSql(buildMovieListQuery(base));
    expect(query.replace(/\s+/g, ' ')).toContain('WHERE am.media_type = $1');
    expect(params[0]).toBe('movie');
  });

  it('groups on the canonical id so a merge loser collapses into its winner', () => {
    expect(render()).toContain('GROUP BY COALESCE(am.merged_into_id, p.media_id)');
  });

  it('aggregates across every identity when no user is given', () => {
    expect(render()).toContain('WHERE am.media_type = $1 GROUP BY');
  });

  it('scopes the aggregate to one identity rather than annotating every row', () => {
    // Filtering in the CTE re-grains plays, last_day and the state together, so
    // one min_state covers both grains and a title the identity never played is
    // absent instead of present-and-unwatched.
    expect(render({ userId: 'user-1' })).toContain('WHERE am.media_type = $1 AND su.user_id = $2');
  });

  it('widens the state filter to started titles when min_state is partial', () => {
    expect(render({ minState: 'partial' })).toContain('WHERE (c.watched_any OR c.has_plays_any)');
  });

  it('keys the cursor predicate on the same tuple the ORDER BY sorts on', () => {
    const query = render({ cursorValue: { startedAt: new Date('2026-01-01'), id: 'media-1' } });
    expect(query).toContain('(c.last_day, c.canonical_id) < ($2::timestamptz, $3::uuid)');
    expect(query).toContain('ORDER BY c.last_day DESC, c.canonical_id DESC');
  });

  it('joins library_items for season and episode numbers only on the episode branch', () => {
    // The lateral runs per surviving candidate, not per returned row, and a
    // movie has no season or episode of its own.
    expect(render({ kind: 'episode' })).toContain('SELECT li.parent_index, li.item_index');
    expect(render()).not.toContain('li.parent_index');
    expect(render()).toContain('NULL::int AS season_number');
  });
});

describe('buildShowListQuery', () => {
  const base = {
    kind: 'show' as const,
    userId: null,
    serverIds: undefined,
    minState: 'watched' as const,
    pageSize: 100,
    cursorValue: null,
  };
  const render = (overrides = {}) =>
    renderSql(buildShowListQuery({ ...base, ...overrides }))
      .sql.replace(/\s+/g, ' ')
      .trim();

  it('counts only episodes still present on a server', () => {
    expect(render()).toContain(
      'FROM library_items li WHERE li.media_id = m.id AND li.removed_at IS NULL'
    );
  });

  it('inner-joins the episode counts so a show with no episodes never appears', () => {
    expect(render()).toContain('JOIN episode_counts ec ON ec.show_id = c.canonical_id');
  });

  it('compares episodes watched against the episode count for the watched filter', () => {
    expect(render()).toContain('WHERE c.eps_watched_any >= ec.episode_count');
  });

  it('counts an episode only when it is one of the active episodes', () => {
    expect(render()).toContain(
      'COUNT(DISTINCT p.media_id) FILTER ( WHERE p.any_watched AND ae.media_id IS NOT NULL )'
    );
  });

  it('scopes the watched episode count to one identity when a user is given', () => {
    expect(render({ userId: 'user-1' })).toContain(
      'WHERE p.show_media_id IS NOT NULL AND su.user_id = $1'
    );
  });

  it('scopes both the plays and the episode count when a server is given', () => {
    const { sql: query, params } = renderSql(buildShowListQuery({ ...base, serverIds: ['srv-1'] }));
    const normalized = query.replace(/\s+/g, ' ');
    // Scoping only the plays would resolve a show whose episodes and plays sit
    // on different servers differently from the library UI.
    expect(normalized).toContain('li.removed_at IS NULL AND li.server_id = $1');
    expect(normalized).toContain('p.show_media_id IS NOT NULL AND p.server_id = $2');
    expect(params.slice(0, 2)).toEqual(['srv-1', 'srv-1']);
  });
});
