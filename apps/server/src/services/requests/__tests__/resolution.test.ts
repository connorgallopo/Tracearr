import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));
vi.mock('../../../db/client.js', () => ({ db: { execute: mockExecute } }));

import { resolveRequests } from '../resolution.js';

function rows(list: Record<string, unknown>[]) {
  return { rows: list };
}

describe('resolveRequests', () => {
  beforeEach(() => mockExecute.mockReset());

  it('matches movies by tmdb, shows by tvdb, and requesters by plex account id on plex', async () => {
    mockExecute
      .mockResolvedValueOnce(
        rows([
          { tmdb_id: 10, tvdb_id: null, media_type: 'movie', id: 'm-1', title: 'Dune', year: 2021 },
        ])
      )
      .mockResolvedValueOnce(
        rows([
          { tmdb_id: 20, tvdb_id: 200, media_type: 'show', id: 'm-2', title: 'Korra', year: 2012 },
        ])
      )
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([{ key: '1577033', id: 'su-1' }]));

    const result = await resolveRequests('svc', 'srv', 'plex', [
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
    mockExecute
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(
        rows([{ rating_key: '206250', media_id: 'm-9', title: 'Late', year: 2026 }])
      )
      .mockResolvedValueOnce(rows([]));
    const result = await resolveRequests('svc', 'srv', 'plex', [
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
    mockExecute
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([{ key: 'jf-abc', id: 'su-7' }]));
    const result = await resolveRequests('svc', 'srv', 'jellyfin', [
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
});
