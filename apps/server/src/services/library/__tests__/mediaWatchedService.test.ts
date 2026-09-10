import { describe, it, expect } from 'vitest';
import {
  buildAliasMapCte,
  buildHydrationQuery,
  buildMovieCandidateQuery,
  buildShowCandidateQuery,
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

describe('buildMovieCandidateQuery', () => {
  const base = {
    kind: 'movie' as const,
    userId: null,
    serverIds: undefined,
    minState: 'watched' as const,
    pageSize: 100,
    cursorValue: null,
  };
  const render = (overrides = {}) =>
    renderSql(buildMovieCandidateQuery({ ...base, ...overrides }))
      .sql.replace(/\s+/g, ' ')
      .trim();

  it('guards on the media type so episode rows never enter the movie list', () => {
    const { sql: query, params } = renderSql(buildMovieCandidateQuery(base));
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

  it('orders the whole candidate set so the cached list can be sliced by cursor', () => {
    // No LIMIT and no keyset predicate: the aggregate reads MAX()/BOOL_OR(), so
    // paging it directly would re-aggregate the cagg once per page.
    const query = render();
    expect(query).toContain('ORDER BY c.last_day DESC, c.canonical_id DESC');
    expect(query).not.toContain('LIMIT');
  });

  it('leaves media metadata to the page hydration, keeping the candidate set narrow', () => {
    // Only ids, ordering keys and aggregates are cached; titles and hierarchy
    // are looked up per page.
    const query = render();
    expect(query).not.toContain('m.title');
    expect(query).not.toContain('li.parent_index');
  });
});

describe('buildShowCandidateQuery', () => {
  const base = {
    kind: 'show' as const,
    userId: null,
    serverIds: undefined,
    minState: 'watched' as const,
    pageSize: 100,
    cursorValue: null,
  };
  const render = (overrides = {}) =>
    renderSql(buildShowCandidateQuery({ ...base, ...overrides }))
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
    const { sql: query, params } = renderSql(
      buildShowCandidateQuery({ ...base, serverIds: ['srv-1'] })
    );
    const normalized = query.replace(/\s+/g, ' ');
    // Scoping only the plays would resolve a show whose episodes and plays sit
    // on different servers differently from the library UI.
    expect(normalized).toContain('li.removed_at IS NULL AND li.server_id = $1');
    expect(normalized).toContain('p.show_media_id IS NOT NULL AND p.server_id = $2');
    expect(params.slice(0, 2)).toEqual(['srv-1', 'srv-1']);
  });
});

describe('buildHydrationQuery', () => {
  const render = (kind: 'movie' | 'show' | 'episode', serverIds: string[] | undefined) =>
    renderSql(buildHydrationQuery(kind, ['11111111-1111-1111-1111-111111111111'], serverIds))
      .sql.replace(/\s+/g, ' ')
      .trim();

  it('scopes the episode numbering lateral to the same servers as the candidate query', () => {
    // Without this a server-scoped request numbers an episode from a copy on a
    // server the caller never asked about.
    expect(render('episode', ['srv-1'])).toContain(
      'WHERE li.media_id = m.id AND li.removed_at IS NULL AND li.server_id = $1'
    );
  });

  it('leaves the lateral unscoped when no server filter was given', () => {
    const query = render('episode', undefined);
    expect(query).toContain('WHERE li.media_id = m.id AND li.removed_at IS NULL ORDER BY');
  });

  it('skips the lateral entirely for movies and shows', () => {
    expect(render('movie', undefined)).not.toContain('li.parent_index');
    expect(render('show', undefined)).not.toContain('li.parent_index');
  });
});
