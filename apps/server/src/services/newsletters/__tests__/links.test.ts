import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  UNSUBSCRIBE_TOKEN_MAX_LENGTH,
  _resetLinkKeyForTests,
  newViewToken,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../links.js';

const RECIPIENT = '3f2c8b1e-9d4a-4c6b-8e7f-1a2b3c4d5e6f';

describe('unsubscribe tokens', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
    delete process.env.ENCRYPTION_KEY;
    _resetLinkKeyForTests();
  });
  afterEach(() => {
    process.env = { ...env };
    _resetLinkKeyForTests();
  });

  it('round-trips a recipient id', () => {
    const token = signUnsubscribeToken(RECIPIENT);
    expect(token.length).toBeLessThanOrEqual(UNSUBSCRIBE_TOKEN_MAX_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyUnsubscribeToken(token)).toBe(RECIPIENT);
  });

  it('rejects a tampered mac, a tampered id, an over-long token, and a non-uuid payload', () => {
    const token = signUnsubscribeToken(RECIPIENT);
    const [id, mac] = token.split('.') as [string, string];
    const flipped = mac.endsWith('A') ? `${mac.slice(0, -1)}B` : `${mac.slice(0, -1)}A`;
    expect(verifyUnsubscribeToken(`${id}.${flipped}`)).toBeNull();
    expect(
      verifyUnsubscribeToken(`${Buffer.from('not-a-uuid').toString('base64url')}.${mac}`)
    ).toBeNull();
    expect(
      verifyUnsubscribeToken(`${token}${'x'.repeat(UNSUBSCRIBE_TOKEN_MAX_LENGTH)}`)
    ).toBeNull();
    expect(verifyUnsubscribeToken('no-dot')).toBeNull();
    expect(verifyUnsubscribeToken('')).toBeNull();
    expect(verifyUnsubscribeToken(signUnsubscribeToken('not-a-uuid'))).toBeNull();
  });

  it('does not verify a token signed under another secret', () => {
    const token = signUnsubscribeToken(RECIPIENT);
    process.env.JWT_SECRET = 'another-secret-entirely';
    _resetLinkKeyForTests();
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it('prefers a well-formed ENCRYPTION_KEY over JWT_SECRET', () => {
    const fromJwt = signUnsubscribeToken(RECIPIENT);
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
    _resetLinkKeyForTests();
    expect(signUnsubscribeToken(RECIPIENT)).not.toBe(fromJwt);
  });

  it('throws when ENCRYPTION_KEY is set but malformed', () => {
    process.env.ENCRYPTION_KEY = 'zz';
    _resetLinkKeyForTests();
    expect(() => signUnsubscribeToken(RECIPIENT)).toThrow(/64 hex/);
  });

  it('view tokens are 43 base64url characters and unique', () => {
    const a = newViewToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newViewToken()).not.toBe(a);
  });
});
