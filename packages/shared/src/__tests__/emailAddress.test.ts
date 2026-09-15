import { describe, expect, it } from 'vitest';
import { isEmailAddress, usernameAsEmail } from '../emailAddress.js';

describe('usernameAsEmail', () => {
  it('trims and lowercases a username that is an email address', () => {
    expect(usernameAsEmail(' Connor.Gallopo@Gmail.com ')).toBe('connor.gallopo@gmail.com');
  });

  it('returns null for a username that is not one', () => {
    expect(usernameAsEmail('Gallapagos')).toBeNull();
    expect(usernameAsEmail('someone@')).toBeNull();
  });

  it('returns null for an address past the 254 character limit', () => {
    const long = `${'a'.repeat(64)}@${'b'.repeat(62)}.${'b'.repeat(62)}.${'b'.repeat(60)}.com`;
    expect(long).toHaveLength(255);
    expect(isEmailAddress(long)).toBe(true);
    expect(usernameAsEmail(long)).toBeNull();
  });
});
