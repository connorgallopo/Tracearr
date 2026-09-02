import { describe, expect, it } from 'vitest';
import { mergeRecipients, type RecipientCandidate } from '../recipients.js';

const c = (over: Partial<RecipientCandidate>): RecipientCandidate => ({
  userId: 'u1',
  name: null,
  contactEmail: null,
  identityEmail: null,
  accountEmails: [],
  ...over,
});

describe('mergeRecipients', () => {
  it('prefers contact email, then identity email, then the first account email', () => {
    const { recipients } = mergeRecipients(
      [
        c({
          userId: 'u1',
          contactEmail: 'c@x.com',
          identityEmail: 'i@x.com',
          accountEmails: ['a@x.com'],
        }),
        c({ userId: 'u2', identityEmail: 'i2@x.com', accountEmails: ['a2@x.com'] }),
        c({ userId: 'u3', accountEmails: ['a3@x.com', 'b3@x.com'] }),
      ],
      [],
      new Set()
    );
    expect(recipients.map((r) => [r.userId, r.address])).toEqual([
      ['u1', 'c@x.com'],
      ['u2', 'i2@x.com'],
      ['u3', 'a3@x.com'],
    ]);
  });

  it('lowercases, dedupes by address with the first identity winning, and counts the address-less', () => {
    const { recipients, missingEmail } = mergeRecipients(
      [
        c({ userId: 'u1', name: 'One', contactEmail: 'Shared@X.com' }),
        c({ userId: 'u2', name: 'Two', identityEmail: 'shared@x.com' }),
        c({ userId: 'u3', name: 'Three' }),
      ],
      [],
      new Set()
    );
    expect(recipients).toEqual([
      { address: 'shared@x.com', userId: 'u1', name: 'One', suppressed: false },
    ]);
    expect(missingEmail).toBe(1);
  });

  it('appends extras that are not already present and flags suppressed addresses', () => {
    const { recipients } = mergeRecipients(
      [c({ userId: 'u1', contactEmail: 'a@x.com' })],
      [
        { address: 'A@X.com', name: 'dup' },
        { address: 'extra@x.com', name: 'Extra' },
      ],
      new Set(['extra@x.com'])
    );
    expect(recipients).toEqual([
      { address: 'a@x.com', userId: 'u1', name: null, suppressed: false },
      { address: 'extra@x.com', userId: null, name: 'Extra', suppressed: true },
    ]);
  });

  it('returns only extras when members are not included', () => {
    const { recipients, missingEmail } = mergeRecipients([], [{ address: 'x@y.com' }], new Set());
    expect(recipients).toEqual([
      { address: 'x@y.com', userId: null, name: null, suppressed: false },
    ]);
    expect(missingEmail).toBe(0);
  });
});
