import { afterEach, describe, expect, it, vi } from 'vitest';
import silo from '../../../../test/mediaServerResponses/silo.json' with { type: 'json' };
import { mapSiloRequest, mapSiloRequestState } from '../requests.js';

const byTitle = (title: string) => {
  const row = silo.requests.items.find((r) => r.title === title);
  if (!row) throw new Error(`no fixture request titled ${title}`);
  return row;
};

const usernames = new Map([
  ['1', 'silo-owner'],
  ['34', 'viewer'],
]);

describe('mapSiloRequestState', () => {
  it('maps the eight Silo states, leaving out cancelled and any unknown state', () => {
    expect(
      [
        'pending',
        'approved',
        'processing',
        'partially_available',
        'available',
        'declined',
        'failed',
        'cancelled',
        'archived',
      ].map(mapSiloRequestState)
    ).toEqual([
      'pending',
      'approved',
      'approved',
      'approved',
      'completed',
      'declined',
      'failed',
      null,
      null,
    ]);
  });
});

describe('mapSiloRequest', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the request id, title, year, account, profile and poster of a movie request', () => {
    expect(mapSiloRequest(byTitle('This Is Spinal Tap'), usernames)).toMatchObject({
      remoteId: '101',
      remoteMediaId: null,
      mediaType: 'movie',
      title: 'This Is Spinal Tap',
      year: 1984,
      tmdbId: 11031,
      tvdbId: null,
      imdbId: 'tt0088258',
      ratingKey: null,
      remoteUserId: '34',
      remoteUsername: 'viewer',
      remotePlexId: null,
      remoteJellyfinUserId: null,
      remoteProfileId: '2770043c-2cab-4bb2-a860-6991aa254f29',
      status: 'pending',
      seasons: null,
      posterPath: '/api/v2/admin/requests/101/poster',
      is4k: false,
      isAutoRequest: false,
      availableAt: null,
    });
  });

  it('completes a season whose aired episodes are all in and gives the rest the request status', () => {
    expect(mapSiloRequest(byTitle('House'), usernames)).toMatchObject({
      mediaType: 'show',
      tvdbId: 73255,
      status: 'approved',
      seasons: [
        { seasonNumber: 1, status: 'completed' },
        { seasonNumber: 2, status: 'approved' },
      ],
    });
  });

  it('gives each requested season the request status until Silo reports its progress', () => {
    expect(mapSiloRequest(byTitle('The Expanse'), usernames)?.seasons).toEqual([
      { seasonNumber: 3, status: 'approved' },
    ]);
  });

  it('lists no seasons for a whole-series request', () => {
    expect(mapSiloRequest(byTitle('Fargo'), usernames)).toMatchObject({
      status: 'declined',
      seasons: [],
    });
  });

  it('lands an available request at its completion and names the library item', () => {
    expect(mapSiloRequest(byTitle('Heat'), usernames)).toMatchObject({
      status: 'completed',
      ratingKey: 'movie-imdb-tt0113277',
      posterPath: null,
      availableAt: new Date('2026-11-20T18:00:00.000Z'),
      remoteUsername: 'silo-owner',
    });
  });

  it('marks a request Silo made from a watchlist as automatic', () => {
    expect(mapSiloRequest(byTitle('The Expanse'), usernames)?.isAutoRequest).toBe(true);
  });

  it('leaves out a cancelled request and one in an unknown state', () => {
    expect(mapSiloRequest(byTitle('Arrival'), usernames)).toBeNull();
    expect(mapSiloRequest({ ...byTitle('Heat'), state: 'archived' }, usernames)).toBeNull();
  });

  it('warns with the request id and state for an unknown state, never for a cancelled one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mapSiloRequest(byTitle('Arrival'), usernames);
    expect(warn).not.toHaveBeenCalled();

    mapSiloRequest({ ...byTitle('Heat'), state: 'archived' }, usernames);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/\[silo-client\] .*\b103\b.*\barchived\b/),
      ''
    );
  });

  it('stores no poster for a poster link that is not a Silo request poster', () => {
    expect(
      mapSiloRequest(
        { ...byTitle('This Is Spinal Tap'), poster_url: 'https://image.tmdb.org/t/p/w500/x.jpg' },
        usernames
      )?.posterPath
    ).toBeNull();
  });

  it('falls back to the account id, then to nothing, for the requester name', () => {
    expect(mapSiloRequest(byTitle('Heat'), new Map())?.remoteUsername).toBe('1');
    const { requested_by_user_id: _, ...nobody } = byTitle('Heat');
    expect(mapSiloRequest(nobody, usernames)).toMatchObject({
      remoteUserId: '',
      remoteUsername: '',
    });
  });
});
