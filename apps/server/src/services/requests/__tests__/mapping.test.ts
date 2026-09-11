import { describe, expect, it } from 'vitest';
import { deriveAvailableAt, mapRequestStatus, mapSeerrRequest } from '../mapping.js';
import type { SeerrRequest } from '../seerrClient.js';

const base: SeerrRequest = {
  id: 738,
  status: 5,
  type: 'tv',
  is4k: false,
  isAutoRequest: true,
  createdAt: '2026-09-07T21:00:20.000Z',
  updatedAt: '2026-09-07T21:05:00.000Z',
  seasons: [{ seasonNumber: 1, status: 5 }],
  media: {
    id: 2081,
    mediaType: 'tv',
    tmdbId: 33880,
    tvdbId: 251085,
    imdbId: null,
    status: 4,
    mediaAddedAt: '2026-09-07T21:01:26.000Z',
    ratingKey: '206215',
    jellyfinMediaId: null,
  },
  requestedBy: { id: 31, displayName: 'agelwarg', plexId: 1577033, jellyfinUserId: null },
};

describe('mapRequestStatus', () => {
  it('maps the five seerr codes and falls back to pending', () => {
    expect([1, 2, 3, 4, 5, 9].map(mapRequestStatus)).toEqual([
      'pending',
      'approved',
      'declined',
      'failed',
      'completed',
      'pending',
    ]);
  });
});

describe('deriveAvailableAt', () => {
  const requestedAt = new Date('2026-09-04T07:10:02.000Z');
  it('uses mediaAddedAt when it is after the request', () => {
    const added = new Date('2026-09-04T07:12:00.000Z');
    expect(
      deriveAvailableAt('completed', requestedAt, added, new Date('2026-09-04T07:50:00Z'))
    ).toEqual(added);
  });
  it('uses the request updatedAt when media was added before the request', () => {
    const updated = new Date('2026-09-04T07:50:00.000Z');
    expect(
      deriveAvailableAt('completed', requestedAt, new Date('2025-12-27T02:21:25Z'), updated)
    ).toEqual(updated);
  });
  it('is null unless completed', () => {
    expect(deriveAvailableAt('approved', requestedAt, new Date(), new Date())).toBeNull();
  });
});

describe('mapSeerrRequest', () => {
  it('maps tv to show, keeps ids, seasons, flags and the requester snapshot without email', () => {
    const mapped = mapSeerrRequest(base);
    expect(mapped).toMatchObject({
      remoteId: 738,
      remoteMediaId: 2081,
      mediaType: 'show',
      tmdbId: 33880,
      tvdbId: 251085,
      imdbId: null,
      ratingKey: '206215',
      remoteUserId: 31,
      remoteUsername: 'agelwarg',
      remotePlexId: '1577033',
      remoteJellyfinUserId: null,
      status: 'completed',
      seasons: [{ seasonNumber: 1, status: 'completed' }],
      is4k: false,
      isAutoRequest: true,
    });
    expect(mapped.requestedAt).toEqual(new Date(base.createdAt));
    expect(mapped.availableAt).toEqual(new Date('2026-09-07T21:01:26.000Z'));
    expect(Object.keys(mapped)).not.toContain('email');
  });

  it('falls back to the jellyfin item id when seerr sends no plex rating key', () => {
    const mapped = mapSeerrRequest({
      ...base,
      media: { ...base.media, ratingKey: null, jellyfinMediaId: 'a1b2c3d4e5f6' },
    });
    expect(mapped.ratingKey).toBe('a1b2c3d4e5f6');
  });

  it('stores null seasons for movies', () => {
    expect(mapSeerrRequest({ ...base, type: 'movie', seasons: [] }).seasons).toBeNull();
  });
});
