import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMBERSHIP_POLICY,
  isMembershipActive,
  membershipStatusFor,
  membershipPolicyDecision,
  shouldEnforceMembership,
} from '../membership.js';

describe('membership status', () => {
  it('treats lifetime and whitelisted memberships as active', () => {
    expect(isMembershipActive('lifetime', null, '2026-10-15')).toBe(true);
    expect(isMembershipActive('whitelisted', '2020-01-01', '2026-10-15')).toBe(true);
  });

  it('derives normal membership status from the paid-through date', () => {
    expect(membershipStatusFor('normal', '2026-10-15', '2026-10-15')).toBe('paid');
    expect(membershipStatusFor('normal', null, '2026-10-15')).toBe('unpaid');
    expect(membershipStatusFor('normal', '2026-10-14', '2026-10-15')).toBe('unpaid');
    expect(isMembershipActive('normal', '2026-10-15', '2026-10-15')).toBe(true);
    expect(isMembershipActive('normal', null, '2026-10-15')).toBe(false);
  });

  it('exempts the Tracearr owner from membership enforcement only', () => {
    expect(shouldEnforceMembership('owner', 'normal', null, '2026-10-15')).toBe(false);
    expect(shouldEnforceMembership('member', 'normal', null, '2026-10-15')).toBe(true);
    expect(shouldEnforceMembership('admin', 'normal', null, '2026-10-15')).toBe(true);
    expect(shouldEnforceMembership('owner', 'normal', '2026-10-15', '2026-10-15')).toBe(false);
  });
});

describe('membership enforcement cadence', () => {
  it('kills only the first stream of each day in daily-annoy mode', () => {
    expect(membershipPolicyDecision('kill_first_stream_daily', 0, null, '2026-10-15')).toEqual({
      shouldKill: true,
      nextPlayCount: 1,
      nextAnnoyDate: '2026-10-15',
    });

    expect(
      membershipPolicyDecision('kill_first_stream_daily', 1, '2026-10-15', '2026-10-15')
    ).toEqual({
      shouldKill: false,
      nextPlayCount: 2,
      nextAnnoyDate: '2026-10-15',
    });
    expect(
      membershipPolicyDecision('kill_first_stream_daily', 2, '2026-10-14', '2026-10-15').shouldKill
    ).toBe(true);
  });

  it('applies every-play and Guardarr every-second/third-play cadence', () => {
    expect(membershipPolicyDecision('kill_every_play', 4, null, '2026-10-15').shouldKill).toBe(
      true
    );
    expect(
      [0, 1, 2, 3].map(
        (count) =>
          membershipPolicyDecision('kill_every_2_plays', count, null, '2026-10-15').shouldKill
      )
    ).toEqual([true, false, true, false]);
    expect(
      [0, 1, 2, 3, 4].map(
        (count) =>
          membershipPolicyDecision('kill_every_3_plays', count, null, '2026-10-15').shouldKill
      )
    ).toEqual([true, false, false, true, false]);
    expect(membershipPolicyDecision('allow_all', 5, null, '2026-10-15')).toEqual({
      shouldKill: false,
      nextPlayCount: 5,
      nextAnnoyDate: null,
    });
  });
});

describe('membership policy default', () => {
  it('defaults identities without an explicit policy to the daily first-stream mode', () => {
    expect(DEFAULT_MEMBERSHIP_POLICY).toBe('kill_first_stream_daily');
  });
});
