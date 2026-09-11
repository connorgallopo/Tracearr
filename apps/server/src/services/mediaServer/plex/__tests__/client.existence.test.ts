import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as HttpModule from '../../../../utils/http.js';
import { PlexClient } from '../client.js';

vi.mock('../../../../utils/http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpModule>()),
  fetchJson: vi.fn(),
  fetchText: vi.fn(),
  plexHeaders: vi.fn().mockReturnValue({ 'X-Plex-Token': 'test-token' }),
}));

import { fetchJson, HttpClientError } from '../../../../utils/http.js';

const mockFetchJson = vi.mocked(fetchJson);

function makeClient() {
  return new PlexClient({ url: 'http://plex.local:32400', token: 'test-token' });
}

function notFound() {
  return new HttpClientError({
    service: 'plex',
    statusCode: 404,
    statusText: 'Not Found',
    url: 'http://plex.local:32400/library/metadata/1',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PlexClient findExistingRatingKeys', () => {
  it('returns the keys the section still has, dropping the ones the lookup left out', async () => {
    mockFetchJson.mockResolvedValue({
      MediaContainer: { Metadata: [{ ratingKey: '2733', librarySectionID: 3 }] },
    });

    const existing = await makeClient().findExistingRatingKeys(['2733', '999999999'], {
      id: '3',
      type: 'movie',
    });

    expect([...existing]).toEqual(['2733']);
    expect(mockFetchJson.mock.calls[0]?.[0]).toBe(
      'http://plex.local:32400/library/metadata/2733,999999999'
    );
  });

  it('treats a 404 as a batch with no survivors and keeps going', async () => {
    mockFetchJson.mockRejectedValue(notFound());

    const existing = await makeClient().findExistingRatingKeys(['1', '2'], {
      id: '3',
      type: 'movie',
    });

    expect(existing.size).toBe(0);
  });

  it('rethrows any other failure so the scan keeps its items', async () => {
    mockFetchJson.mockRejectedValue(new Error('ECONNRESET'));

    await expect(
      makeClient().findExistingRatingKeys(['1'], { id: '3', type: 'movie' })
    ).rejects.toThrow('ECONNRESET');
  });
});
