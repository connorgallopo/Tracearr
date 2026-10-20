import { eq } from 'drizzle-orm';
import type {
  MembershipEnforcementPolicy,
  MembershipStatus,
  MembershipType,
  UserRole,
} from '@tracearr/shared';
import { db, type Executor } from '../db/client.js';
import { sessions, users } from '../db/schema.js';

export const DEFAULT_MEMBERSHIP_POLICY: MembershipEnforcementPolicy = 'kill_first_stream_daily';

export function membershipStatusFor(
  type: MembershipType,
  expirationDate: string | null,
  today: string
): MembershipStatus {
  if (type === 'lifetime' || type === 'whitelisted') return type;
  return expirationDate !== null && expirationDate >= today ? 'paid' : 'unpaid';
}

export function isMembershipActive(
  type: MembershipType,
  expirationDate: string | null,
  today: string
): boolean {
  return membershipStatusFor(type, expirationDate, today) !== 'unpaid';
}

export function shouldEnforceMembership(
  role: UserRole,
  type: MembershipType,
  expirationDate: string | null,
  today: string
): boolean {
  return role !== 'owner' && !isMembershipActive(type, expirationDate, today);
}

export function membershipPolicyDecision(
  policy: MembershipEnforcementPolicy,
  playCount: number,
  lastAnnoyDate: string | null,
  today: string
): { shouldKill: boolean; nextPlayCount: number; nextAnnoyDate: string | null } {
  const nextPlayCount = playCount + 1;
  switch (policy) {
    case 'kill_first_stream_daily':
      return {
        shouldKill: lastAnnoyDate !== today,
        nextPlayCount,
        nextAnnoyDate: lastAnnoyDate === today ? lastAnnoyDate : today,
      };
    case 'kill_every_play':
      return { shouldKill: true, nextPlayCount, nextAnnoyDate: lastAnnoyDate };
    case 'kill_every_2_plays':
      return {
        shouldKill: nextPlayCount % 2 === 1,
        nextPlayCount,
        nextAnnoyDate: lastAnnoyDate,
      };
    case 'kill_every_3_plays':
      return {
        shouldKill: nextPlayCount % 3 === 1,
        nextPlayCount,
        nextAnnoyDate: lastAnnoyDate,
      };
    case 'allow_all':
      return { shouldKill: false, nextPlayCount: playCount, nextAnnoyDate: lastAnnoyDate };
  }
}

/**
 * Resolve and persist the membership condition once per session. The stored result
 * keeps delayed kill re-verification stable and the identity lock serializes cadence.
 */
export async function membershipEnforcementDue(
  sessionId: string,
  userId: string,
  startedAt: Date,
  isSessionStartedEvent: boolean,
  executor?: Executor
): Promise<boolean> {
  const resolve = async (executor: Executor): Promise<boolean> => {
    const [session] = await executor
      .select({
        decision: sessions.membershipEnforcementDecision,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for('update')
      .limit(1);
    if (!session) return false;
    if (session.decision !== null) return session.decision;
    if (!isSessionStartedEvent) return false;

    const [identity] = await executor
      .select({
        role: users.role,
        membershipType: users.membershipType,
        membershipExpirationDate: users.membershipExpirationDate,
        membershipEnforcementPolicy: users.membershipEnforcementPolicy,
        membershipPlayCount: users.membershipPlayCount,
        membershipLastAnnoyDate: users.membershipLastAnnoyDate,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for('update')
      .limit(1);
    if (!identity) return false;

    const today = startedAt.toISOString().slice(0, 10);
    let shouldKill = false;
    let nextPlayCount = identity.membershipPlayCount;
    let nextAnnoyDate = identity.membershipLastAnnoyDate;

    if (
      shouldEnforceMembership(
        identity.role,
        identity.membershipType,
        identity.membershipExpirationDate,
        today
      )
    ) {
      const decision = membershipPolicyDecision(
        identity.membershipEnforcementPolicy ?? DEFAULT_MEMBERSHIP_POLICY,
        identity.membershipPlayCount,
        identity.membershipLastAnnoyDate,
        today
      );
      shouldKill = decision.shouldKill;
      nextPlayCount = decision.nextPlayCount;
      nextAnnoyDate = decision.nextAnnoyDate;
    }

    if (
      nextPlayCount !== identity.membershipPlayCount ||
      nextAnnoyDate !== identity.membershipLastAnnoyDate
    ) {
      await executor
        .update(users)
        .set({
          membershipPlayCount: nextPlayCount,
          membershipLastAnnoyDate: nextAnnoyDate,
        })
        .where(eq(users.id, userId));
    }
    await executor
      .update(sessions)
      .set({ membershipEnforcementDecision: shouldKill })
      .where(eq(sessions.id, sessionId));
    return shouldKill;
  };

  return executor ? resolve(executor) : db.transaction(resolve);
}
