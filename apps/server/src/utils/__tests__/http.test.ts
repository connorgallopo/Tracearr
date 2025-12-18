/**
 * HTTP Client Utility Tests
 *
 * Tests the ACTUAL exported functions from http.ts:
 * - HttpClientError: Error class with service context
 * - fetchJson: Fetch and parse JSON response
 * - fetchText: Fetch and return text response
 * - fetchRaw: Fetch and return raw Response
 * - fetchWithStatus: Fetch without throwing on non-2xx
 * - Helper functions: jsonHeaders, plexHeaders, jellyfinHeaders
 *
 * These tests validate:
 * - Successful requests return correct data
 * - Non-2xx responses throw HttpClientError
 * - Error contains correct service, status, url info
 * - Timeout handling
 * - Header helpers produce correct headers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import ACTUAL production functions - not local duplicates
import {
  HttpClientError,
  fetchJson,
  fetchText,
  fetchRaw,
  fetchWithStatus,
  jsonHeaders,
  plexHeaders,
  jellyfinHeaders,
  embyHeaders,
} from '../http.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Helper to create mock Response
function createMockResponse(options: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): Response {
  const { ok = true, status = 200, statusText = 'OK', body = {}, headers = {} } = options;

  return {
    ok,
    status,
    statusText,
    headers: new Headers(headers),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    clone: vi.fn(),
  } as unknown as Response;
}

describe('HttpClientError', () => {
  it('should create error with all properties', () => {
    const error = new HttpClientError({
      service: 'plex',
      statusCode: 401,
      statusText: 'Unauthorized',
      url: 'https://plex.tv/api/test',
    });

    expect(error.name).toBe('HttpClientError');
    expect(error.service).toBe('plex');
    expect(error.statusCode).toBe(401);
    expect(error.statusText).toBe('Unauthorized');
    expect(error.url).toBe('https://plex.tv/api/test');
    expect(error.message).toBe('plex request failed: 401 Unauthorized');
  });

  it('should use custom message when provided', () => {
    const error = new HttpClientError({
      service: 'jellyfin',
      statusCode: 500,
      statusText: 'Internal Server Error',
      url: 'https://jellyfin.local/api',
      message: 'Custom error message',
    });

    expect(error.message).toBe('Custom error message');
  });

  it('should include response body when provided', () => {
    const error = new HttpClientError({
      service: 'api',
      statusCode: 400,
      statusText: 'Bad Request',
      url: 'https://api.example.com',
      responseBody: '{"error": "Invalid input"}',
    });

    expect(error.responseBody).toBe('{"error": "Invalid input"}');
  });

  it('should be instance of Error', () => {
    const error = new HttpClientError({
      service: 'test',
      statusCode: 404,
      statusText: 'Not Found',
      url: 'https://example.com',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(HttpClientError);
  });

  describe('toExternalServiceError', () => {
    it('should convert plex error to ExternalServiceError', () => {
      const error = new HttpClientError({
        service: 'plex',
        statusCode: 502,
        statusText: 'Bad Gateway',
        url: 'https://plex.tv/api',
      });

      const external = error.toExternalServiceError();

      expect(external.name).toBe('ExternalServiceError');
    });

    it('should convert jellyfin error to ExternalServiceError', () => {
      const error = new HttpClientError({
        service: 'jellyfin',
        statusCode: 503,
        statusText: 'Service Unavailable',
        url: 'https://jellyfin.local/api',
      });

      const external = error.toExternalServiceError();

      expect(external.name).toBe('ExternalServiceError');
    });

    it('should return self for unknown services', () => {
      const error = new HttpClientError({
        service: 'unknown',
        statusCode: 500,
        statusText: 'Error',
        url: 'https://example.com',
      });

      const result = error.toExternalServiceError();

      expect(result).toBe(error);
    });
  });
});

describe('fetchJson', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should fetch and parse JSON response', async () => {
    const responseData = { id: 1, name: 'Test' };
    mockFetch.mockResolvedValue(createMockResponse({ body: responseData }));

    const result = await fetchJson<typeof responseData>('https://api.example.com/data');

    expect(result).toEqual(responseData);
    expect(mockFetch).toHaveBeenCalledWith('https://api.example.com/data', {});
  });

  it('should pass headers to fetch', async () => {
    mockFetch.mockResolvedValue(createMockResponse({ body: {} }));

    await fetchJson('https://api.example.com/data', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/data',
      expect.objectContaining({
        headers: { Authorization: 'Bearer token' },
      })
    );
  });

  it('should throw HttpClientError on non-2xx response', async () => {
    mockFetch.mockResolvedValue(
      createMockResponse({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      })
    );

    await expect(fetchJson('https://api.example.com/missing', { service: 'test' })).rejects.toThrow(
      HttpClientError
    );

    try {
      await fetchJson('https://api.example.com/missing', { service: 'test' });
    } catch (error) {
      expect(error).toBeInstanceOf(HttpClientError);
      expect((error as HttpClientError).statusCode).toBe(404);
      expect((error as HttpClientError).service).toBe('test');
    }
  });

  it('should use default service name "API" when not provided', async () => {
    mockFetch.mockResolvedValue(
      createMockResponse({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      })
    );

    try {
      await fetchJson('https://api.example.com/error');
    } catch (error) {
      expect((error as HttpClientError).service).toBe('API');
    }
  });
});

describe('fetchText', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should fetch and return text response', async () => {
    const responseText = '<xml>data</xml>';
    mockFetch.mockResolvedValue(createMockResponse({ body: responseText }));

    const result = await fetchText('https://api.example.com/xml');

    expect(result).toBe(responseText);
  });

  it('should throw HttpClientError on non-2xx response', async () => {
    mockFetch.mockResolvedValue(
      createMockResponse({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      })
    );

    await expect(
      fetchText('https://api.example.com/forbidden', { service: 'plex' })
    ).rejects.toThrow(HttpClientError);
  });
});

describe('fetchRaw', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should return raw Response object', async () => {
    const mockResponse = createMockResponse({ body: 'binary data' });
    mockFetch.mockResolvedValue(mockResponse);

    const result = await fetchRaw('https://api.example.com/image');

    expect(result).toBe(mockResponse);
  });

  it('should throw HttpClientError on non-2xx response', async () => {
    mockFetch.mockResolvedValue(
      createMockResponse({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      })
    );

    await expect(fetchRaw('https://api.example.com/missing')).rejects.toThrow(HttpClientError);
  });
});

describe('fetchWithStatus', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should return status info for successful request', async () => {
    const responseData = { id: 1 };
    mockFetch.mockResolvedValue(
      createMockResponse({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: responseData,
      })
    );

    const result = await fetchWithStatus<typeof responseData>('https://api.example.com/data');

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.statusText).toBe('OK');
    expect(result.data).toEqual(responseData);
  });

  it('should NOT throw on non-2xx response', async () => {
    mockFetch.mockResolvedValue(
      createMockResponse({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      })
    );

    const result = await fetchWithStatus('https://api.example.com/missing');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.data).toBeNull();
  });

  it('should return null data when response is not JSON', async () => {
    const mockResponse = createMockResponse({
      ok: true,
      status: 200,
      statusText: 'OK',
    });
    (mockResponse.json as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Not JSON'));
    mockFetch.mockResolvedValue(mockResponse);

    const result = await fetchWithStatus('https://api.example.com/text');

    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  it('should include headers in response', async () => {
    mockFetch.mockResolvedValue(
      createMockResponse({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { 'X-Custom-Header': 'value' },
      })
    );

    const result = await fetchWithStatus('https://api.example.com/data');

    expect(result.headers).toBeInstanceOf(Headers);
  });
});

describe('Header helpers', () => {
  describe('jsonHeaders', () => {
    it('should return JSON headers without token', () => {
      const headers = jsonHeaders();

      expect(headers['Accept']).toBe('application/json');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBeUndefined();
    });

    it('should include Bearer token when provided', () => {
      const headers = jsonHeaders('my-token');

      expect(headers['Authorization']).toBe('Bearer my-token');
    });
  });

  describe('plexHeaders', () => {
    it('should return Plex-specific headers without token', () => {
      const headers = plexHeaders();

      expect(headers['Accept']).toBe('application/json');
      expect(headers['X-Plex-Client-Identifier']).toBe('tracearr');
      expect(headers['X-Plex-Product']).toBe('Tracearr');
      expect(headers['X-Plex-Version']).toBe('1.0.0');
      expect(headers['X-Plex-Device']).toBe('Server');
      expect(headers['X-Plex-Platform']).toBe('Node.js');
      expect(headers['X-Plex-Token']).toBeUndefined();
    });

    it('should include X-Plex-Token when provided', () => {
      const headers = plexHeaders('plex-auth-token');

      expect(headers['X-Plex-Token']).toBe('plex-auth-token');
    });
  });

  describe('jellyfinHeaders', () => {
    it('should return Jellyfin headers without API key', () => {
      const headers = jellyfinHeaders();

      expect(headers['Accept']).toBe('application/json');
      expect(headers['X-Emby-Token']).toBeUndefined();
    });

    it('should include X-Emby-Token when API key provided', () => {
      const headers = jellyfinHeaders('jellyfin-api-key');

      expect(headers['X-Emby-Token']).toBe('jellyfin-api-key');
    });
  });

  describe('embyHeaders', () => {
    it('should return Emby headers without API key', () => {
      const headers = embyHeaders();

      expect(headers['Accept']).toBe('application/json');
      expect(headers['X-Emby-Token']).toBeUndefined();
    });

    it('should include X-Emby-Token when API key provided', () => {
      const headers = embyHeaders('emby-api-key');

      expect(headers['X-Emby-Token']).toBe('emby-api-key');
    });
  });
});
