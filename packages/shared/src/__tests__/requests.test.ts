import { describe, expect, it } from 'vitest';
import {
  createRequestServiceSchema,
  testRequestServiceSchema,
  updateRequestServiceSchema,
  userRequestsQuerySchema,
} from '../requests.js';

describe('request service schemas', () => {
  it('accepts a create body and trims the url', () => {
    const parsed = createRequestServiceSchema.parse({
      serverId: '6f1c2c1e-0a7b-4c1b-9d1e-1a2b3c4d5e6f',
      url: ' http://seerr.local:5055/ ',
      apiKey: 'abc',
    });
    expect(parsed.url).toBe('http://seerr.local:5055');
    expect(parsed.name).toBeUndefined();
  });

  it('rejects unknown keys and empty keys', () => {
    expect(testRequestServiceSchema.safeParse({ url: 'http://x', apiKey: '' }).success).toBe(false);
    expect(
      createRequestServiceSchema.safeParse({
        serverId: '6f1c2c1e-0a7b-4c1b-9d1e-1a2b3c4d5e6f',
        url: 'http://x',
        apiKey: 'k',
        extra: 1,
      }).success
    ).toBe(false);
  });

  it('update allows a partial body and a blank apiKey means keep', () => {
    expect(updateRequestServiceSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(updateRequestServiceSchema.safeParse({ apiKey: '' }).success).toBe(false);
  });

  it('user requests query defaults page and pageSize', () => {
    expect(userRequestsQuerySchema.parse({})).toEqual({ page: 1, pageSize: 5 });
    expect(userRequestsQuerySchema.parse({ scope: 'identity', pageSize: '50' })).toEqual({
      scope: 'identity',
      page: 1,
      pageSize: 50,
    });
  });
});
