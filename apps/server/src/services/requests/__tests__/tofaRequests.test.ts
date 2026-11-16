import { describe, expect, it } from 'vitest';
import tofa from '../../../test/mediaServerResponses/tofa.json' with { type: 'json' };
import { mapTofaRequest, mapTofaRequestStatus } from '../tofaRequests.js';

const byTitle = (title: string) => {
  const row = tofa.requests.find((r) => r.title === title);
  if (!row) throw new Error(`no fixture request titled ${title}`);
  return row;
};

describe('mapTofaRequestStatus', () => {
  it('maps the seven tofa statuses and falls back to pending', () => {
    expect(
      [
        'pending_approval',
        'requested',
        'downloading',
        'retrying',
        'available',
        'denied',
        'failed',
        'archived',
      ].map(mapTofaRequestStatus)
    ).toEqual([
      'pending',
      'approved',
      'approved',
      'approved',
      'completed',
      'declined',
      'failed',
      'pending',
    ]);
  });
});

describe('mapTofaRequest', () => {
  it('keeps the request id, title and tofa user, with no media id of its own', () => {
    expect(mapTofaRequest(byTitle('Copper Coast'))).toMatchObject({
      remoteId: '5a1d0000-4c2e-4f6a-9b3d-000000000001',
      remoteMediaId: null,
      mediaType: 'show',
      title: 'Copper Coast',
      tmdbId: 900101,
      tvdbId: 800101,
      remoteUserId: 'b1e4c7a2-5d38-4f91-8a6c-2e7f0d3b9c14',
      remoteUsername: 'morgan',
      status: 'pending',
      seasons: [{ seasonNumber: 2, status: 'pending' }],
      availableAt: null,
    });
  });

  it('maps each season of a show by its own status', () => {
    expect(mapTofaRequest(byTitle('Quiet Harbor')).seasons).toEqual([
      { seasonNumber: 1, status: 'completed' },
      { seasonNumber: 2, status: 'approved' },
    ]);
  });

  it('gives a request filed for someone to the person it is for', () => {
    const mapped = mapTofaRequest(byTitle('Salt Meridian'));
    expect(mapped.remoteUserId).toBe('c9a3f6d1-8e24-4b57-a0c8-6d1e5f2a7b38');
    expect(mapped.status).toBe('declined');
    expect(mapped.seasons).toBeNull();
  });

  it('lands an available request when tofa resolved it', () => {
    expect(mapTofaRequest(byTitle('Lantern Field')).availableAt).toEqual(
      new Date('2025-03-14T09:30:00.000Z')
    );
  });
});
