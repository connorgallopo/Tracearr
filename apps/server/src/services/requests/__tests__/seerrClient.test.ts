import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SeerrApiError, SeerrClient, seerrRequestsPageSchema } from '../seerrClient.js';

const KEY = 'secret-key-value';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const requestRow = {
  id: 740,
  status: 5,
  type: 'movie',
  is4k: false,
  isAutoRequest: false,
  createdAt: '2026-09-08T23:49:53.000Z',
  updatedAt: '2026-09-08T23:55:00.000Z',
  seasons: [],
  media: {
    id: 2084,
    mediaType: 'movie',
    tmdbId: 1433367,
    tvdbId: null,
    imdbId: null,
    status: 5,
    mediaAddedAt: '2026-09-08T23:52:05.000Z',
    ratingKey: '206250',
    jellyfinMediaId: null,
    downloadStatus: [],
  },
  requestedBy: {
    id: 31,
    displayName: 'agelwarg',
    plexId: 1577033,
    jellyfinUserId: null,
    email: 'someone@example.test',
  },
};

describe('SeerrClient', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('sends the key only in X-Api-Key and appends /api/v1', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ version: '1.0.0', commitTag: 'abc' }));
    const client = new SeerrClient('http://seerr.local:5055', KEY);
    await client.status();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://seerr.local:5055/api/v1/status');
    expect(new Headers(init?.headers).get('x-api-key')).toBe(KEY);
    expect(String(url)).not.toContain(KEY);
  });

  it('refuses a link-local base url before any request', () => {
    expect(() => new SeerrClient('http://169.254.1.1:5055', KEY)).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses a requests page and keeps unknown fields out of the typed shape', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        pageInfo: { page: 1, pages: 1, results: 1, pageSize: 100 },
        results: [requestRow],
      })
    );
    const page = await new SeerrClient('http://seerr.local:5055', KEY).requestsPage(0, 100);
    expect(page.results).toHaveLength(1);
    expect(page.results[0]?.requestedBy.plexId).toBe(1577033);
    expect(page.results[0]?.media.ratingKey).toBe('206250');
  });

  it('strips the key from error messages on a failed response', async () => {
    fetchMock.mockResolvedValue(new Response(`unauthorised ${KEY}`, { status: 403 }));
    const client = new SeerrClient('http://seerr.local:5055', KEY);
    await expect(client.requestCount()).rejects.toMatchObject({ status: 403 });
    await client.requestCount().catch((error: unknown) => {
      expect(error).toBeInstanceOf(SeerrApiError);
      expect((error as Error).message).not.toContain(KEY);
    });
  });

  it('schema tolerates a null requester plexId and missing seasons', () => {
    const parsed = seerrRequestsPageSchema.parse({
      pageInfo: { page: 1, pages: 1, results: 1, pageSize: 100 },
      results: [
        {
          ...requestRow,
          seasons: undefined,
          requestedBy: { ...requestRow.requestedBy, plexId: null, jellyfinUserId: 'jf-1' },
        },
      ],
    });
    expect(parsed.results[0]?.seasons).toEqual([]);
    expect(parsed.results[0]?.requestedBy.jellyfinUserId).toBe('jf-1');
  });
});
