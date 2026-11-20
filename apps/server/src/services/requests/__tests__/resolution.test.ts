import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));
vi.mock('../../../db/client.js', () => ({ db: { execute: mockExecute } }));

import { BUILT_IN_REQUESTER, seerrRequesterIdentity } from '../mapping.js';
import { resolveRequests, type ResolutionInput } from '../resolution.js';

function rows(list: Record<string, unknown>[]) {
  return { rows: list };
}

function sqlTextOf(query: unknown): string {
  return JSON.stringify(query);
}

/**
 * Dispatches by which table/predicate the query targets instead of a fixed
 * call order: `resolveRequests` skips a lookup entirely when its id set is
 * empty, so neither which queries are issued nor their order is fixed.
 */
function routeByQuery(
  routes: {
    movie?: Record<string, unknown>[];
    show?: Record<string, unknown>[];
    ratingKey?: Record<string, unknown>[];
    requester?: Record<string, unknown>[];
    profile?: Record<string, unknown>[];
  } = {}
) {
  mockExecute.mockImplementation(async (query: unknown) => {
    const text = sqlTextOf(query);
    if (text.includes("media_type = 'movie'")) return rows(routes.movie ?? []);
    if (text.includes("media_type = 'show'")) return rows(routes.show ?? []);
    if (text.includes('library_items')) return rows(routes.ratingKey ?? []);
    if (text.includes('server_users')) return rows(routes.requester ?? []);
    if (text.includes('server_profiles')) return rows(routes.profile ?? []);
    throw new Error(`unexpected query: ${text}`);
  });
}

const base: ResolutionInput = {
  remoteId: '1',
  remoteUserId: '31',
  mediaType: 'movie',
  tmdbId: null,
  tvdbId: null,
  ratingKey: null,
  remotePlexId: null,
  remoteJellyfinUserId: null,
  remoteProfileId: null,
};

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

    const result = await resolveRequests('srv', seerrRequesterIdentity('plex'), [
      { ...base, remoteId: '1', tmdbId: 10, remotePlexId: '1577033' },
      {
        ...base,
        remoteId: '2',
        mediaType: 'show',
        tmdbId: 20,
        tvdbId: 200,
        remotePlexId: '1577033',
      },
      { ...base, remoteId: '3', tmdbId: 99, remotePlexId: '5' },
    ]);

    expect(result.get('1')).toEqual({
      mediaId: 'm-1',
      serverUserId: 'su-1',
      profileId: null,
      title: 'Dune',
      year: 2021,
    });
    expect(result.get('2')).toEqual({
      mediaId: 'm-2',
      serverUserId: 'su-1',
      profileId: null,
      title: 'Korra',
      year: 2012,
    });
    expect(result.get('3')).toEqual({
      mediaId: null,
      serverUserId: null,
      profileId: null,
      title: null,
      year: null,
    });
  });

  it('falls back to the rating key on the linked server', async () => {
    routeByQuery({
      ratingKey: [{ rating_key: '206250', media_id: 'm-9', title: 'Late', year: 2026 }],
    });
    const result = await resolveRequests('srv', seerrRequesterIdentity('plex'), [
      { ...base, remoteId: '7', tmdbId: 1, ratingKey: '206250' },
    ]);
    expect(result.get('7')?.mediaId).toBe('m-9');
    expect(result.get('7')?.title).toBe('Late');
  });

  it('matches requesters by external id on jellyfin and emby', async () => {
    routeByQuery({
      requester: [{ key: 'jf-abc', id: 'su-7' }],
    });
    const result = await resolveRequests('srv', seerrRequesterIdentity('jellyfin'), [
      { ...base, remoteJellyfinUserId: 'jf-abc' },
    ]);
    expect(result.get('1')?.serverUserId).toBe('su-7');
  });

  it("matches a server's own requester by its user id stored as the external id", async () => {
    routeByQuery({
      requester: [{ key: 'b1e4c7a2-5d38-4f91-8a6c-2e7f0d3b9c14', id: 'su-9' }],
    });
    const result = await resolveRequests('srv', BUILT_IN_REQUESTER, [
      {
        ...base,
        remoteId: '5a1d0000-4c2e-4f6a-9b3d-000000000001',
        remoteUserId: 'b1e4c7a2-5d38-4f91-8a6c-2e7f0d3b9c14',
        mediaType: 'show',
      },
    ]);
    expect(result.get('5a1d0000-4c2e-4f6a-9b3d-000000000001')?.serverUserId).toBe('su-9');
    expect(sqlTextOf(mockExecute.mock.calls[0]?.[0])).toContain('external_id');
  });

  it('links the stored profile a request names by the server profile id', async () => {
    routeByQuery({ profile: [{ key: 'p-kid', id: 'sp-1' }] });
    const out = await resolveRequests('srv', BUILT_IN_REQUESTER, [
      { ...base, remoteProfileId: 'p-kid' },
    ]);
    expect(out.get(base.remoteId)?.profileId).toBe('sp-1');
  });

  it('issues no profile query when no request names a profile', async () => {
    routeByQuery();
    await resolveRequests('srv', seerrRequesterIdentity('plex'), [
      { ...base, remoteProfileId: null },
    ]);
    expect(
      mockExecute.mock.calls.map(([q]) => sqlTextOf(q)).some((t) => t.includes('server_profiles'))
    ).toBe(false);
  });

  it('skips a lookup entirely when its id set is empty', async () => {
    routeByQuery();
    await resolveRequests('srv', seerrRequesterIdentity('plex'), [base]);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
