/**
 * User merge service
 *
 * Implements the users-level merge from the auth overhaul design:
 * absorb a source identity into a target identity, combine same-server
 * accounts, record an audit row, and support split as the undo path.
 */

import { alias } from 'drizzle-orm/pg-core';
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { canLogin, type UserRole } from '@tracearr/shared';
import type {
  MergeSuggestion,
  MergeSuggestionIdentity,
  ServerUserSplitResult,
  UserMergeResult,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import {
  users,
  serverUsers,
  serverUserExternalAliases,
  servers,
  sessions,
  automationRuns,
  automations,
  plexAccounts,
  mobileSessions,
  mobileTokens,
  terminationLogs,
  authAccounts,
  userMergeAudits,
} from '../db/schema.js';
import { uncapDecompressionForTx } from '../db/timescale.js';
import { invalidateAutomationsCache } from '../jobs/poller/database.js';
import { getAuth } from '../lib/auth.js';
import {
  recomputeIdentityAggregates,
  ServerUserNotFoundError,
  UserNotFoundError,
} from './userService.js';

export interface MergeIdentitySnapshot {
  id: string;
  role: UserRole;
  passwordHash: string | null;
  plexAccountId: string | null;
  linkedPlexAccountCount: number;
  // Better Auth account rows for this user, any provider (credential/plex/OIDC).
  // Tracked separately from passwordHash because users.password_hash is
  // scheduled to be dropped in a later cleanup release.
  authAccountCount: number;
}

export class MergeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeValidationError';
    Object.setPrototypeOf(this, MergeValidationError.prototype);
  }
}

export class MergeDirectionError extends MergeValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'MergeDirectionError';
    Object.setPrototypeOf(this, MergeDirectionError.prototype);
  }
}

export class SameServerCombineNotConfirmedError extends MergeValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'SameServerCombineNotConfirmedError';
    Object.setPrototypeOf(this, SameServerCombineNotConfirmedError.prototype);
  }
}

export function isLoginCapable(user: MergeIdentitySnapshot): boolean {
  return (
    canLogin(user.role) ||
    user.passwordHash !== null ||
    user.plexAccountId !== null ||
    user.linkedPlexAccountCount > 0 ||
    user.authAccountCount > 0
  );
}

export function assertMergeDirection(
  source: MergeIdentitySnapshot,
  target: MergeIdentitySnapshot
): void {
  void target;
  if (isLoginCapable(source)) {
    throw new MergeDirectionError(
      'A login-capable account can only be the target of a merge, never the absorbed side'
    );
  }
}

export interface ServerUserRef {
  id: string;
  serverId: string;
}

export interface MergePlan {
  repointServerUserIds: string[];
  combines: { sourceServerUserId: string; targetServerUserId: string; serverId: string }[];
}

export function planServerUserMoves(
  sourceServerUsers: ServerUserRef[],
  targetServerUsers: ServerUserRef[]
): MergePlan {
  const targetByServer = new Map(targetServerUsers.map((su) => [su.serverId, su]));
  const plan: MergePlan = { repointServerUserIds: [], combines: [] };

  for (const sourceSu of sourceServerUsers) {
    const targetSu = targetByServer.get(sourceSu.serverId);
    if (targetSu) {
      plan.combines.push({
        sourceServerUserId: sourceSu.id,
        targetServerUserId: targetSu.id,
        serverId: sourceSu.serverId,
      });
    } else {
      plan.repointServerUserIds.push(sourceSu.id);
    }
  }

  return plan;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function loadIdentitySnapshot(tx: Tx, userId: string): Promise<MergeIdentitySnapshot> {
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    throw new UserNotFoundError(userId);
  }
  const [plexCount] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(plexAccounts)
    .where(eq(plexAccounts.userId, userId));
  const [authAccountCountRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(authAccounts)
    .where(eq(authAccounts.userId, userId));
  return {
    id: user.id,
    role: user.role,
    passwordHash: user.passwordHash,
    plexAccountId: user.plexAccountId,
    linkedPlexAccountCount: plexCount?.count ?? 0,
    authAccountCount: authAccountCountRow?.count ?? 0,
  };
}

export interface MergedIdentityRowIds {
  plexAccountIds: string[];
  mobileSessionIds: string[];
  mobileTokenIds: string[];
}

async function repointIdentityRows(
  tx: Tx,
  sourceUserId: string,
  targetUserId: string
): Promise<MergedIdentityRowIds> {
  // Ids are captured via .returning() so the audit row can record exactly
  // which rows moved. Split uses that record to move them back onto the
  // restored identity; it never has to guess which rows on the target
  // originated from this source.
  const movedPlexAccounts = await tx
    .update(plexAccounts)
    .set({ userId: targetUserId })
    .where(eq(plexAccounts.userId, sourceUserId))
    .returning({ id: plexAccounts.id });
  const movedMobileSessions = await tx
    .update(mobileSessions)
    .set({ userId: targetUserId })
    .where(eq(mobileSessions.userId, sourceUserId))
    .returning({ id: mobileSessions.id });
  const movedMobileTokens = await tx
    .update(mobileTokens)
    .set({ createdBy: targetUserId })
    .where(eq(mobileTokens.createdBy, sourceUserId))
    .returning({ id: mobileTokens.id });
  await tx
    .update(terminationLogs)
    .set({ triggeredByUserId: targetUserId })
    .where(eq(terminationLogs.triggeredByUserId, sourceUserId));
  // Identity (person)-scoped rules move with the identity, same as the rows
  // above, but are deliberately not tracked for split to reverse: unlike a
  // per-server rule conflict, there is no other identity-scoped rule to
  // compare names against here, so nothing is lost by leaving them on the
  // target - the restored identity from a split just starts without them.
  await tx
    .update(automations)
    .set({ userId: targetUserId, updatedAt: new Date() })
    .where(eq(automations.userId, sourceUserId));
  // terminationLogs.triggeredByUserId is deliberately not tracked for split to
  // reverse: it records which admin manually triggered a termination, not an
  // attribute of the terminated account, so there is no source-identity row to
  // faithfully hand back. It stays on the target after both merge and split.
  // Better Auth login rows (auth_accounts / auth_sessions) are deliberately
  // never touched here. assertMergeDirection already proved the source owns
  // zero auth_accounts rows, so there is nothing to repoint; its sessions are
  // revoked (not moved) through internalAdapter in mergeUsers instead, since
  // Better Auth has no primitive to re-key a session onto another user.
  return {
    plexAccountIds: movedPlexAccounts.map((r) => r.id),
    mobileSessionIds: movedMobileSessions.map((r) => r.id),
    mobileTokenIds: movedMobileTokens.map((r) => r.id),
  };
}

// Reverses repointIdentityRows for exactly the rows an audit recorded as
// moved by this merge. Only rows still owned by fromUserId are touched, so a
// second split of a multi-account merge (which matches the same audit) is a
// harmless no-op for rows an earlier split in the same merge already claimed.
async function repointIdentityRowsBack(
  tx: Tx,
  movedIds: MergedIdentityRowIds,
  fromUserId: string,
  toUserId: string
): Promise<void> {
  if (movedIds.plexAccountIds.length > 0) {
    await tx
      .update(plexAccounts)
      .set({ userId: toUserId })
      .where(
        and(inArray(plexAccounts.id, movedIds.plexAccountIds), eq(plexAccounts.userId, fromUserId))
      );
  }
  if (movedIds.mobileSessionIds.length > 0) {
    await tx
      .update(mobileSessions)
      .set({ userId: toUserId })
      .where(
        and(
          inArray(mobileSessions.id, movedIds.mobileSessionIds),
          eq(mobileSessions.userId, fromUserId)
        )
      );
  }
  if (movedIds.mobileTokenIds.length > 0) {
    await tx
      .update(mobileTokens)
      .set({ createdBy: toUserId })
      .where(
        and(
          inArray(mobileTokens.id, movedIds.mobileTokenIds),
          eq(mobileTokens.createdBy, fromUserId)
        )
      );
  }
}

async function combineServerUsers(
  tx: Tx,
  sourceServerUserId: string,
  targetServerUserId: string
): Promise<string[]> {
  const [sourceSu] = await tx
    .select()
    .from(serverUsers)
    .where(eq(serverUsers.id, sourceServerUserId))
    .limit(1);
  const [targetSu] = await tx
    .select()
    .from(serverUsers)
    .where(eq(serverUsers.id, targetServerUserId))
    .limit(1);
  if (!sourceSu || !targetSu) {
    throw new MergeValidationError('server user disappeared during merge');
  }

  // server_user_id is a compress_segmentby key, so repointing an account with
  // real history rewrites whole compressed segments. The default per-DML cap
  // aborts the merge partway through once that gets large enough.
  await uncapDecompressionForTx(tx);

  await tx
    .update(sessions)
    .set({ serverUserId: targetServerUserId })
    .where(eq(sessions.serverUserId, sourceServerUserId));
  await tx
    .update(automationRuns)
    .set({ serverUserId: targetServerUserId })
    .where(eq(automationRuns.serverUserId, sourceServerUserId));
  await tx
    .update(terminationLogs)
    .set({ serverUserId: targetServerUserId })
    .where(eq(terminationLogs.serverUserId, sourceServerUserId));

  // Per-user rule overrides: primary wins on name conflicts, the rest move over.
  // Conflicting source rules are dropped rather than kept as duplicates; their
  // names are returned so the caller can tell the admin what didn't survive.
  const targetRuleRows = await tx
    .select({ name: automations.name })
    .from(automations)
    .where(eq(automations.serverUserId, targetServerUserId));
  const targetRuleNames = new Set(targetRuleRows.map((r) => r.name));
  const sourceRuleRows = await tx
    .select({ id: automations.id, name: automations.name })
    .from(automations)
    .where(eq(automations.serverUserId, sourceServerUserId));
  const droppedRuleNames: string[] = [];
  for (const rule of sourceRuleRows) {
    if (targetRuleNames.has(rule.name)) {
      droppedRuleNames.push(rule.name);
      await tx.delete(automations).where(eq(automations.id, rule.id));
    } else {
      await tx
        .update(automations)
        .set({ serverUserId: targetServerUserId, updatedAt: new Date() })
        .where(eq(automations.id, rule.id));
    }
  }

  // Primary metadata wins; only null gaps are filled from the source.
  // removedAt is never carried over here: the source row is being folded
  // into a live target, so the surviving row must stay active even if the
  // source had been soft-removed (e.g. a re-created account absorbing the
  // history of an old, removed one).
  await tx
    .update(serverUsers)
    .set({
      email: targetSu.email ?? sourceSu.email,
      thumbUrl: targetSu.thumbUrl ?? sourceSu.thumbUrl,
      plexAccountId: targetSu.plexAccountId ?? sourceSu.plexAccountId,
      joinedAt:
        targetSu.joinedAt && sourceSu.joinedAt
          ? new Date(Math.min(targetSu.joinedAt.getTime(), sourceSu.joinedAt.getTime()))
          : (targetSu.joinedAt ?? sourceSu.joinedAt),
      lastActivityAt:
        targetSu.lastActivityAt && sourceSu.lastActivityAt
          ? new Date(Math.max(targetSu.lastActivityAt.getTime(), sourceSu.lastActivityAt.getTime()))
          : (targetSu.lastActivityAt ?? sourceSu.lastActivityAt),
      updatedAt: new Date(),
    })
    .where(eq(serverUsers.id, targetServerUserId));

  // Aliases already pointing at the source would cascade away with it.
  await tx
    .update(serverUserExternalAliases)
    .set({ serverUserId: targetServerUserId })
    .where(eq(serverUserExternalAliases.serverUserId, sourceServerUserId));

  // The media server still reports the source's external id. Claim it for the
  // surviving row, or the next session recreates the account we just folded.
  await tx
    .insert(serverUserExternalAliases)
    .values({
      serverId: sourceSu.serverId,
      externalId: sourceSu.externalId,
      serverUserId: targetServerUserId,
    })
    .onConflictDoUpdate({
      target: [serverUserExternalAliases.serverId, serverUserExternalAliases.externalId],
      set: { serverUserId: targetServerUserId },
    });

  await tx.delete(serverUsers).where(eq(serverUsers.id, sourceServerUserId));

  return droppedRuleNames;
}

export interface MergeUsersOptions {
  confirmSameServerCombine?: boolean;
}

export async function mergeUsers(
  sourceUserId: string,
  targetUserId: string,
  actingUserId: string,
  options: MergeUsersOptions = {}
): Promise<UserMergeResult> {
  if (sourceUserId === targetUserId) {
    throw new MergeValidationError('cannot merge an identity into itself');
  }

  const result = await db.transaction(async (tx) => {
    const source = await loadIdentitySnapshot(tx, sourceUserId);
    const target = await loadIdentitySnapshot(tx, targetUserId);
    assertMergeDirection(source, target);

    const [sourceUser] = await tx.select().from(users).where(eq(users.id, sourceUserId)).limit(1);

    const sourceSus = await tx
      .select({ id: serverUsers.id, serverId: serverUsers.serverId })
      .from(serverUsers)
      .where(eq(serverUsers.userId, sourceUserId));
    const targetSus = await tx
      .select({ id: serverUsers.id, serverId: serverUsers.serverId })
      .from(serverUsers)
      .where(eq(serverUsers.userId, targetUserId));

    const plan = planServerUserMoves(sourceSus, targetSus);

    if (plan.combines.length > 0 && !options.confirmSameServerCombine) {
      throw new SameServerCombineNotConfirmedError(
        'both identities have an account on the same server; combining them is irreversible and requires explicit confirmation'
      );
    }

    // The direction check above already proved the source owns zero
    // auth_accounts rows. Revoke its Better Auth sessions before the first
    // destructive write below so a ghost Redis session cannot keep working
    // for up to 30 days after the source row is deleted (deleting the row by
    // SQL clears the DB session rows via cascade but never touches the Redis
    // secondary storage). This writes through Better Auth's own connection,
    // not this transaction: if the transaction later aborts, the worst case
    // is a revoked session for a user who could not log in anyway (safe
    // direction, fail-closed). It must stay after the confirmation guard
    // above so a rejected merge leaves the source's sessions untouched.
    await (await getAuth().$context).internalAdapter.deleteUserSessions(sourceUserId);

    const droppedRuleNames: string[] = [];
    for (const combine of plan.combines) {
      const dropped = await combineServerUsers(
        tx,
        combine.sourceServerUserId,
        combine.targetServerUserId
      );
      droppedRuleNames.push(...dropped);
    }

    if (plan.repointServerUserIds.length > 0) {
      await tx
        .update(serverUsers)
        .set({ userId: targetUserId, updatedAt: new Date() })
        .where(inArray(serverUsers.id, plan.repointServerUserIds));
    }

    const movedIdentityRowIds = await repointIdentityRows(tx, sourceUserId, targetUserId);
    await recomputeIdentityAggregates(targetUserId, tx);

    // If this source was itself the target of an earlier merge, that earlier
    // audit's targetUserId still points at it. user_merge_audits.targetUserId
    // cascades on delete, so repoint it onto the new target before the source
    // row is deleted below - otherwise the earlier merge's undo record is
    // silently destroyed and that chain can never be split again. This must
    // survive every merge in a chain, however long, so split stays possible
    // all the way back to the original identity. actingUserId is left alone:
    // it identifies the admin who ran that earlier merge, not an account
    // being folded away by this one.
    await tx
      .update(userMergeAudits)
      .set({ targetUserId })
      .where(eq(userMergeAudits.targetUserId, sourceUserId));

    await tx.delete(users).where(eq(users.id, sourceUserId));

    const [audit] = await tx
      .insert(userMergeAudits)
      .values({
        sourceUserId,
        targetUserId,
        actingUserId,
        movedServerUserIds: plan.repointServerUserIds,
        combinedServerUsers: plan.combines,
        wasSameServerCombine: plan.combines.length > 0,
        sourceUserSnapshot: {
          username: sourceUser!.username,
          name: sourceUser!.name,
          email: sourceUser!.email,
          thumbnail: sourceUser!.thumbnail,
          role: sourceUser!.role,
        },
        movedIdentityRowIds,
      })
      .returning();

    return {
      targetUserId,
      auditId: audit!.id,
      movedServerUserIds: plan.repointServerUserIds,
      combinedServerUsers: plan.combines,
      wasSameServerCombine: plan.combines.length > 0,
      droppedRuleNames,
    };
  });

  invalidateAutomationsCache();

  // recomputeIdentityAggregates wrote the target's columns with raw SQL,
  // which any live session's cached Redis snapshot never sees on its own
  // (the snapshot freezes the user object at write time). Refresh it here so
  // stale identity data does not survive until the snapshot expires (up to
  // 30 days).
  const authCtx = await getAuth().$context;
  const freshTarget = await authCtx.internalAdapter.findUserById(targetUserId);
  if (freshTarget) {
    await authCtx.internalAdapter.refreshUserSessions(freshTarget);
  }

  return result;
}

export async function splitServerUser(
  serverUserId: string,
  actingUserId: string
): Promise<ServerUserSplitResult> {
  void actingUserId;

  const result = await db.transaction(async (tx) => {
    const [serverUser] = await tx
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, serverUserId))
      .limit(1);
    if (!serverUser) {
      throw new ServerUserNotFoundError(serverUserId);
    }

    const siblings = await tx
      .select({ id: serverUsers.id })
      .from(serverUsers)
      .where(eq(serverUsers.userId, serverUser.userId));
    if (siblings.length < 2) {
      throw new MergeValidationError('cannot split the only server account of an identity');
    }

    // Prefer the audit snapshot from the merge that moved this server user.
    // Ordered oldest first, not newest: a chained merge (A into B, then B
    // into C) leaves this account's id in both the A->B and B->C audits once
    // Gap-1 repointing has retargeted the earlier one onto C, since B->C's
    // own repoint list includes every account B already owned, including
    // ones absorbed from A. The oldest matching audit is the one that
    // actually moved this specific account away from its own identity, so it
    // holds the snapshot this split should restore; a native account of B
    // (never part of A) only ever appears in the newer B->C audit, so this
    // still resolves correctly for it too.
    const [audit] = await tx
      .select()
      .from(userMergeAudits)
      .where(
        and(
          eq(userMergeAudits.targetUserId, serverUser.userId),
          isNull(userMergeAudits.undoneAt),
          sql`${userMergeAudits.movedServerUserIds} @> ${JSON.stringify([serverUserId])}::jsonb`
        )
      )
      .orderBy(asc(userMergeAudits.createdAt))
      .limit(1);

    const identity = audit
      ? audit.sourceUserSnapshot
      : {
          username: serverUser.username,
          name: null as string | null,
          email: serverUser.email,
          thumbnail: serverUser.thumbUrl,
          role: 'member',
        };

    let email = identity.email?.toLowerCase() ?? null;
    if (email) {
      const [emailTaken] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (emailTaken) {
        email = null;
      }
    }

    // Raw insert, not Better Auth's create-user path: user.create.before
    // enforces single-owner/claim-code signup rules that would wrongly
    // reject or mutate this restored identity, which is not a new signup.
    // Role is always member on a split identity; splitting never grants login.
    const [newUser] = await tx
      .insert(users)
      .values({
        username: identity.username,
        name: identity.name,
        email,
        thumbnail: identity.thumbnail,
        role: 'member',
      })
      .returning();

    const oldUserId = serverUser.userId;
    await tx
      .update(serverUsers)
      .set({ userId: newUser!.id, updatedAt: new Date() })
      .where(eq(serverUsers.id, serverUserId));

    if (audit) {
      // Move exactly the plex_accounts / mobile_sessions / mobile_tokens rows
      // this merge recorded as moved, back onto the restored identity. Older
      // audits written before movedIdentityRowIds existed have it null, so
      // this is a no-op for them - the fallback path's current behavior
      // (those rows stay on the target) is preserved on purpose.
      if (audit.movedIdentityRowIds) {
        await repointIdentityRowsBack(tx, audit.movedIdentityRowIds, oldUserId, newUser!.id);
      }

      // A multi-account merge (movedServerUserIds has more than one entry)
      // must stay usable for further splits until every account it moved has
      // been split away. Marking it undone after only the first split would
      // make the next split of the same merge miss the audit filter above
      // and fall back to bare server_user fields, losing that account's
      // identity snapshot. Derived from current ownership rather than a
      // separate counter, so a later split via a different (older, chained)
      // audit for one of these accounts still counts toward this check.
      const [stillOwned] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(serverUsers)
        .where(
          and(
            inArray(serverUsers.id, audit.movedServerUserIds),
            eq(serverUsers.userId, audit.targetUserId)
          )
        );
      if ((stillOwned?.count ?? 0) === 0) {
        await tx
          .update(userMergeAudits)
          .set({ undoneAt: new Date() })
          .where(eq(userMergeAudits.id, audit.id));
      }
    }

    await recomputeIdentityAggregates(oldUserId, tx);
    await recomputeIdentityAggregates(newUser!.id, tx);

    return { newUserId: newUser!.id, serverUserId, oldUserId };
  });

  // The old identity's aggregates changed above but any live session's
  // cached Redis snapshot still holds the pre-split user object (the
  // snapshot freezes the user at write time). Refresh it so a logged-in
  // target does not keep stale identity data until the snapshot expires (up
  // to 30 days). The new identity is skipped: it was just created and
  // cannot have any sessions yet.
  const authCtx = await getAuth().$context;
  const freshOldUser = await authCtx.internalAdapter.findUserById(result.oldUserId);
  if (freshOldUser) {
    await authCtx.internalAdapter.refreshUserSessions(freshOldUser);
  }

  return { newUserId: result.newUserId, serverUserId: result.serverUserId };
}

// Matches server_users.email/username across identities, never users.email
// (that column is already unique, so two identities can never share it).
export async function getMergeSuggestions(): Promise<MergeSuggestion[]> {
  const a = alias(serverUsers, 'su_a');
  const b = alias(serverUsers, 'su_b');

  const emailMatch = sql`${a.email} IS NOT NULL AND ${b.email} IS NOT NULL AND lower(${a.email}) = lower(${b.email})`;

  // No removedAt filter here on purpose: soft-removed server_users (accounts
  // that no longer exist on the media server) still participate in matching.
  // The primary case this feature exists for is merging an old removed
  // account into its replacement on the same server, so excluding removed
  // rows would hide exactly the suggestions we want to surface. The UI
  // labels removed accounts to the reviewer.
  const pairRows = await db
    .selectDistinct({
      userA: sql<string>`least(${a.userId}, ${b.userId})`,
      userB: sql<string>`greatest(${a.userId}, ${b.userId})`,
      matchType: sql<
        'email' | 'username'
      >`case when ${emailMatch} then 'email' else 'username' end`,
      matchValue: sql<string>`case when ${emailMatch} then lower(${a.email}) else ${a.username} end`,
    })
    .from(a)
    .innerJoin(
      b,
      and(
        ne(a.userId, b.userId),
        lt(a.id, b.id),
        or(sql`${emailMatch}`, eq(a.username, b.username))
      )
    );

  if (pairRows.length === 0) return [];

  // One suggestion per identity pair; email matches outrank username matches.
  // When two rows share the same matchType, the lexicographically smallest
  // matchValue wins so the result never depends on unspecified SQL row order.
  const pairKey = (row: (typeof pairRows)[number]) => `${row.userA}:${row.userB}`;
  const bestByPair = new Map<string, (typeof pairRows)[number]>();
  for (const row of pairRows) {
    const existing = bestByPair.get(pairKey(row));
    const rowIsBetterMatchType = existing?.matchType === 'username' && row.matchType === 'email';
    const rowIsSmallerValue =
      existing?.matchType === row.matchType && row.matchValue < existing.matchValue;
    if (!existing || rowIsBetterMatchType || rowIsSmallerValue) {
      bestByPair.set(pairKey(row), row);
    }
  }

  const userIds = [...new Set([...bestByPair.values()].flatMap((r) => [r.userA, r.userB]))];

  const userRows = await db.select().from(users).where(inArray(users.id, userIds));
  const userById = new Map(userRows.map((u) => [u.id, u]));

  const suRows = await db
    .select({
      id: serverUsers.id,
      userId: serverUsers.userId,
      serverId: serverUsers.serverId,
      serverName: servers.name,
      username: serverUsers.username,
      email: serverUsers.email,
      removedAt: serverUsers.removedAt,
    })
    .from(serverUsers)
    .innerJoin(servers, eq(serverUsers.serverId, servers.id))
    .where(inArray(serverUsers.userId, userIds));
  const susByUser = new Map<string, typeof suRows>();
  for (const su of suRows) {
    const list = susByUser.get(su.userId) ?? [];
    list.push(su);
    susByUser.set(su.userId, list);
  }

  const plexCounts = await db
    .select({ userId: plexAccounts.userId, count: sql<number>`count(*)::int` })
    .from(plexAccounts)
    .where(inArray(plexAccounts.userId, userIds))
    .groupBy(plexAccounts.userId);
  const plexCountByUser = new Map(plexCounts.map((r) => [r.userId, r.count]));

  const authAccountCounts = await db
    .select({ userId: authAccounts.userId, count: sql<number>`count(*)::int` })
    .from(authAccounts)
    .where(inArray(authAccounts.userId, userIds))
    .groupBy(authAccounts.userId);
  const authAccountCountByUser = new Map(authAccountCounts.map((r) => [r.userId, r.count]));

  const toIdentity = (userId: string): MergeSuggestionIdentity | null => {
    const user = userById.get(userId);
    if (!user) return null;
    const sus = susByUser.get(userId) ?? [];
    return {
      userId: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      role: user.role,
      loginCapable: isLoginCapable({
        id: user.id,
        role: user.role,
        passwordHash: user.passwordHash,
        plexAccountId: user.plexAccountId,
        linkedPlexAccountCount: plexCountByUser.get(userId) ?? 0,
        authAccountCount: authAccountCountByUser.get(userId) ?? 0,
      }),
      serverUsers: sus.map((su) => ({
        id: su.id,
        serverId: su.serverId,
        serverName: su.serverName,
        username: su.username,
        email: su.email,
        removedAt: su.removedAt ? su.removedAt.toISOString() : null,
      })),
    };
  };

  const suggestions: MergeSuggestion[] = [];
  for (const row of bestByPair.values()) {
    const first = toIdentity(row.userA);
    const second = toIdentity(row.userB);
    if (!first || !second) continue;
    // Both identities login-capable has no valid merge direction; nothing to suggest.
    if (first.loginCapable && second.loginCapable) continue;

    const firstServerIds = new Set(first.serverUsers.map((su) => su.serverId));
    const wouldCombineSameServer = second.serverUsers.some((su) => firstServerIds.has(su.serverId));

    suggestions.push({
      matchType: row.matchType,
      matchValue: row.matchValue,
      users: [first, second],
      requiredTargetUserId: first.loginCapable
        ? first.userId
        : second.loginCapable
          ? second.userId
          : null,
      wouldCombineSameServer,
    });
  }

  suggestions.sort((x, y) =>
    x.matchType === y.matchType
      ? x.matchValue.localeCompare(y.matchValue)
      : x.matchType === 'email'
        ? -1
        : 1
  );
  return suggestions;
}
