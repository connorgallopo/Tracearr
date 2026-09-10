import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as HttpModule from '../../../../utils/http.js';

vi.mock('../../../../utils/http.js', async (importActual) => {
  const actual = await importActual<typeof HttpModule>();
  return { ...actual, fetchJson: vi.fn() };
});

import { fetchJson, HttpClientError } from '../../../../utils/http.js';
import { EmbyClient } from '../client.js';

const mockFetchJson = vi.mocked(fetchJson);

const URL = 'http://emby.local:8096';

function httpError(statusCode: number): HttpClientError {
  return new HttpClientError({
    service: 'emby',
    statusCode,
    statusText: 'error',
    url: `${URL}/x`,
  });
}

function sequence(...steps: Array<{ resolve?: unknown; reject?: Error }>) {
  let call = 0;
  mockFetchJson.mockImplementation(async () => {
    const step = steps[call++];
    if (!step) throw new Error('unexpected fetchJson call');
    if (step.reject) throw step.reject;
    return step.resolve;
  });
}

describe('EmbyClient.verifyServerAdmin', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  it('sends the Emby authorization header and probes the public info endpoint first', async () => {
    sequence(
      { resolve: {} },
      { resolve: { Id: 'u1', Name: 'a', Policy: { IsAdministrator: true } } }
    );

    await EmbyClient.verifyServerAdmin('key', URL);

    expect(mockFetchJson.mock.calls[0]?.[0]).toBe(`${URL}/System/Info/Public`);
    const usersMeCall = mockFetchJson.mock.calls[1];
    const headers = (usersMeCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Emby-Authorization']).toContain('MediaBrowser');
  });

  it('succeeds for an admin user token via /Users/Me', async () => {
    sequence(
      { resolve: {} },
      { resolve: { Id: 'u1', Name: 'a', Policy: { IsAdministrator: true } } }
    );

    expect(await EmbyClient.verifyServerAdmin('key', URL)).toEqual({ success: true });
  });

  it('returns NOT_ADMIN for a non-admin user token', async () => {
    sequence(
      { resolve: {} },
      { resolve: { Id: 'u1', Name: 'a', Policy: { IsAdministrator: false } } }
    );

    expect(await EmbyClient.verifyServerAdmin('key', URL)).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.NOT_ADMIN,
    });
  });

  it('succeeds for an admin API key via /Auth/Keys after /Users/Me answers 500', async () => {
    sequence({ resolve: {} }, { reject: httpError(500) }, { resolve: {} });

    expect(await EmbyClient.verifyServerAdmin('key', URL)).toEqual({ success: true });
  });

  it('returns INVALID_KEY when /Users/Me answers 401', async () => {
    sequence({ resolve: {} }, { reject: httpError(401) });

    expect(await EmbyClient.verifyServerAdmin('bad', URL)).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.INVALID_KEY,
    });
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });

  it('returns INVALID_KEY when /Auth/Keys answers 401', async () => {
    sequence({ resolve: {} }, { reject: httpError(500) }, { reject: httpError(401) });

    expect(await EmbyClient.verifyServerAdmin('bad', URL)).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.INVALID_KEY,
    });
  });

  it('returns NOT_ADMIN when /Auth/Keys answers 403', async () => {
    sequence({ resolve: {} }, { reject: httpError(500) }, { reject: httpError(403) });

    expect(await EmbyClient.verifyServerAdmin('key', URL)).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.NOT_ADMIN,
    });
  });

  it('returns CONNECTION_FAILED when the server is unreachable', async () => {
    sequence({ reject: new Error('ECONNREFUSED') });

    expect(await EmbyClient.verifyServerAdmin('key', URL)).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.CONNECTION_FAILED,
    });
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });
});
