import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));
vi.mock('../../../db/client.js', () => ({ db: { execute: mockExecute } }));

import { resolveRequests } from '../resolution.js';

function rows(list: Record<string, unknown>[]) {
  return { rows: list };
}

function sqlTextOf(query: unknown): string {
  return JSON.stringify(query);
}

/**
 * Dispatches by which table/predicate the query targets instead of a fixed
 * call order: `resolveRequests` skips a lookup entirely when its id set is
 * empty, so the four queries are not always issued, and in what order.
 */
function routeByQuery(
  routes: {
    movie?: Record<string, unknown>[];
    show?: Record<string, unknown>[];
    ratingKey?: Record<string, unknown>[];
    requester?: Record<string, unknown>[];
  } = {}
) {
  mockExecute.mockImplementation(async (query: unknown) => {
    const text = sqlTextOf(query);
    if (text.includes("media_type = 'movie'")) return rows(routes.movie ?? []);
    if (text.includes("media_type = 'show'")) return rows(routes.show ?? []);
    if (text.includes('library_items')) return rows(routes.ratingKey ?? []);
    if (text.includes('server_users')) return rows(routes.requester ?? []);
    throw new Error(`unexpected query: ${text}`);
  });
}

describe('resolveRequests', () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it('matches movies by tmdb, shows by tvdb, and requesters by plex account id on plex', async () => {
    routeByQuery({
      movie: [
        { tmdb_id: 10, tvdb_id: null, media_type: 'movie', id: 'm-1', title: 'Dune', year: 2021 },
      ],
      show: [
        { tmdb_id: 20, tvdb_id: 200, media_type: 'show', id: 'm-2', title: 'Korra', year: 2012 },
      ],
      requester: [{ key: '1577033', id: 'su-1' }],
    });

    const result = await resolveRequests('srv', 'plex', [
      {
        remoteId: 1,
        mediaType: 'movie',
        tmdbId: 10,
        tvdbId: null,
        ratingKey: null,
        remotePlexId: '1577033',
        remoteJellyfinUserId: null,
      },
      {
        remoteId: 2,
        mediaType: 'show',
        tmdbId: 20,
        tvdbId: 200,
        ratingKey: null,
        remotePlexId: '1577033',
        remoteJellyfinUserId: null,
      },
      {
        remoteId: 3,
        mediaType: 'movie',
        tmdbId: 99,
        tvdbId: null,
        ratingKey: null,
        remotePlexId: '5',
        remoteJellyfinUserId: null,
      },
    ]);

    expect(result.get(1)).toEqual({
      mediaId: 'm-1',
      serverUserId: 'su-1',
      title: 'Dune',
      year: 2021,
    });
    expect(result.get(2)).toEqual({
      mediaId: 'm-2',
      serverUserId: 'su-1',
      title: 'Korra',
      year: 2012,
    });
    expect(result.get(3)).toEqual({ mediaId: null, serverUserId: null, title: null, year: null });
  });

  it('falls back to the rating key on the linked server', async () => {
    routeByQuery({
      ratingKey: [{ rating_key: '206250', media_id: 'm-9', title: 'Late', year: 2026 }],
    });
    const result = await resolveRequests('srv', 'plex', [
      {
        remoteId: 7,
        mediaType: 'movie',
        tmdbId: 1,
        tvdbId: null,
        ratingKey: '206250',
        remotePlexId: null,
        remoteJellyfinUserId: null,
      },
    ]);
    expect(result.get(7)?.mediaId).toBe('m-9');
    expect(result.get(7)?.title).toBe('Late');
  });

  it('matches requesters by external id on jellyfin and emby', async () => {
    routeByQuery({
      requester: [{ key: 'jf-abc', id: 'su-7' }],
    });
    const result = await resolveRequests('srv', 'jellyfin', [
      {
        remoteId: 1,
        mediaType: 'movie',
        tmdbId: null,
        tvdbId: null,
        ratingKey: null,
        remotePlexId: null,
        remoteJellyfinUserId: 'jf-abc',
      },
    ]);
    expect(result.get(1)?.serverUserId).toBe('su-7');
  });

  it('skips a lookup entirely when its id set is empty', async () => {
    routeByQuery();
    await resolveRequests('srv', 'plex', [
      {
        remoteId: 1,
        mediaType: 'movie',
        tmdbId: null,
        tvdbId: null,
        ratingKey: null,
        remotePlexId: null,
        remoteJellyfinUserId: null,
      },
    ]);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
