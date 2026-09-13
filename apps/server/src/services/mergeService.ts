/**
 * User merge service
 *
 * Implements the users-level merge from the auth overhaul design:
 * absorb a source identity into a target identity, combine same-server
 * accounts, record an audit row, and support split as the undo path.
 */

import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq, inArray, isNull, like, lt, ne, or, sql } from 'drizzle-orm';
import { canLogin, rankMergeTarget, type MergeRankInput, type UserRole } from '@tracearr/shared';
import type {
  DismissedMergeSuggestion,
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
  mediaRequests,
  plexAccounts,
  mobileSessions,
  mobileTokens,
  newsletters,
  newsletterSendRecipients,
  terminationLogs,
  authAccounts,
  userMergeAudits,
  dismissals,
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
  await tx
    .update(mediaRequests)
    .set({ serverUserId: targetServerUserId })
    .where(eq(mediaRequests.serverUserId, sourceServerUserId));

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
    if (!sourceUser) {
      throw new UserNotFoundError(sourceUserId);
    }

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

    // The delete would null these rows and orphan the jsonb exclusions; split hands neither back.
    await tx
      .update(newsletterSendRecipients)
      .set({ userId: targetUserId })
      .where(eq(newsletterSendRecipients.userId, sourceUserId));
    const excluding = await tx
      .select({ id: newsletters.id, recipients: newsletters.recipients })
      .from(newsletters)
      .where(
        sql`${newsletters.recipients}->'excludeUserIds' @> ${JSON.stringify([sourceUserId])}::jsonb`
      );
    for (const newsletter of excluding) {
      const excludeUserIds = [
        ...new Set(
          newsletter.recipients.excludeUserIds.map((id) =>
            id === sourceUserId ? targetUserId : id
          )
        ),
      ];
      await tx
        .update(newsletters)
        .set({ recipients: { ...newsletter.recipients, excludeUserIds } })
        .where(eq(newsletters.id, newsletter.id));
    }

    const carriedContactEmail = sourceUser.contactEmail
      ? await tx
          .update(users)
          .set({ contactEmail: sourceUser.contactEmail, updatedAt: new Date() })
          .where(and(eq(users.id, targetUserId), isNull(users.contactEmail)))
          .returning({ id: users.id })
      : [];

    const sourceKey = sourceUserId.toLowerCase();
    await tx
      .delete(dismissals)
      .where(
        and(
          eq(dismissals.kind, 'merge_suggestion'),
          or(
            like(dismissals.subjectKey, `${sourceKey}:%`),
            like(dismissals.subjectKey, `%:${sourceKey}`)
          )
        )
      );

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
          username: sourceUser.username,
          name: sourceUser.name,
          email: sourceUser.email,
          thumbnail: sourceUser.thumbnail,
          role: sourceUser.role,
          contactEmail: sourceUser.contactEmail,
          contactEmailCarried: carriedContactEmail.length > 0,
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

    const [accountServer] = await tx
      .select({ type: servers.type })
      .from(servers)
      .where(eq(servers.id, serverUser.serverId))
      .limit(1);

    const identity = audit
      ? audit.sourceUserSnapshot
      : {
          username: serverUser.username,
          name: null as string | null,
          // A Jellyfin or Emby account's email is its username, never an identity email.
          email: accountServer?.type === 'plex' ? serverUser.email : null,
          thumbnail: serverUser.thumbUrl,
          role: 'member',
          contactEmail: null,
          contactEmailCarried: false,
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
        contactEmail: identity.contactEmail ?? null,
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

      // Only a gap-filled address the owner has not since retyped goes back.
      const { contactEmail, contactEmailCarried } = audit.sourceUserSnapshot;
      if (contactEmailCarried && contactEmail) {
        await tx
          .update(users)
          .set({ contactEmail: null, updatedAt: new Date() })
          .where(and(eq(users.id, oldUserId), eq(users.contactEmail, contactEmail)));
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
  const pairKey = (row: (typeof pairRows)[number]) => mergeSuggestionKey(row.userA, row.userB);
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

  const dismissedRows = await db
    .select({ subjectKey: dismissals.subjectKey })
    .from(dismissals)
    .where(
      and(
        eq(dismissals.kind, 'merge_suggestion'),
        inArray(dismissals.subjectKey, [...bestByPair.keys()])
      )
    );
  for (const { subjectKey } of dismissedRows) {
    bestByPair.delete(subjectKey);
  }

  const identities = await loadMergeIdentities([
    ...new Set([...bestByPair.values()].flatMap((r) => [r.userA, r.userB])),
  ]);

  const suggestions: MergeSuggestion[] = [];
  for (const row of bestByPair.values()) {
    const first = identities.get(row.userA);
    const second = identities.get(row.userB);
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
      suggestedTargetUserId: rankMergeTarget(toRankInput(first), toRankInput(second)),
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

// Lowercase hex order is uuid byte order, so this matches least()/greatest() in the pair query.
function mergeSuggestionKey(userA: string, userB: string): string {
  const a = userA.toLowerCase();
  const b = userB.toLowerCase();
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function toRankInput(identity: MergeSuggestionIdentity): MergeRankInput {
  return {
    ...identity,
    removed: identity.serverUsers.every((su) => su.removedAt !== null),
  };
}

async function loadMergeIdentities(
  userIds: string[]
): Promise<Map<string, MergeSuggestionIdentity>> {
  if (userIds.length === 0) return new Map();

  const [userRows, suRows, plexCounts, authAccountCounts, sessionCounts] = await Promise.all([
    db.select().from(users).where(inArray(users.id, userIds)),
    db
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
      .where(inArray(serverUsers.userId, userIds)),
    db
      .select({ userId: plexAccounts.userId, count: sql<number>`count(*)::int` })
      .from(plexAccounts)
      .where(inArray(plexAccounts.userId, userIds))
      .groupBy(plexAccounts.userId),
    db
      .select({ userId: authAccounts.userId, count: sql<number>`count(*)::int` })
      .from(authAccounts)
      .where(inArray(authAccounts.userId, userIds))
      .groupBy(authAccounts.userId),
    // All-time count, so there is no started_at bound to prune chunks with. The
    // daily_bandwidth_by_user aggregate would be cheaper but only exists when the
    // TimescaleDB extension is installed.
    db
      .select({ userId: serverUsers.userId, count: sql<number>`count(*)::int` })
      .from(sessions)
      .innerJoin(serverUsers, eq(sessions.serverUserId, serverUsers.id))
      .where(inArray(serverUsers.userId, userIds))
      .groupBy(serverUsers.userId),
  ]);

  const susByUser = new Map<string, typeof suRows>();
  for (const su of suRows) {
    const list = susByUser.get(su.userId) ?? [];
    list.push(su);
    susByUser.set(su.userId, list);
  }
  const plexCountByUser = new Map(plexCounts.map((r) => [r.userId, r.count]));
  const authAccountCountByUser = new Map(authAccountCounts.map((r) => [r.userId, r.count]));
  const sessionCountByUser = new Map(sessionCounts.map((r) => [r.userId, r.count]));

  return new Map(
    userRows.map((user): [string, MergeSuggestionIdentity] => [
      user.id,
      {
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
          linkedPlexAccountCount: plexCountByUser.get(user.id) ?? 0,
          authAccountCount: authAccountCountByUser.get(user.id) ?? 0,
        }),
        lastActivityAt: user.lastActivityAt?.toISOString() ?? null,
        sessionCount: sessionCountByUser.get(user.id) ?? 0,
        serverUsers: (susByUser.get(user.id) ?? []).map((su) => ({
          id: su.id,
          serverId: su.serverId,
          serverName: su.serverName,
          username: su.username,
          email: su.email,
          removedAt: su.removedAt ? su.removedAt.toISOString() : null,
        })),
      },
    ])
  );
}

export async function getDismissedMergeSuggestions(): Promise<DismissedMergeSuggestion[]> {
  const identityExists = (part: 1 | 2) =>
    sql`exists (select 1 from ${users} where ${users.id} = split_part(${dismissals.subjectKey}, ':', ${sql.raw(String(part))})::uuid)`;
  const rows = await db
    .select({ subjectKey: dismissals.subjectKey, createdAt: dismissals.createdAt })
    .from(dismissals)
    .where(and(eq(dismissals.kind, 'merge_suggestion'), identityExists(1), identityExists(2)))
    .orderBy(desc(dismissals.createdAt), asc(dismissals.subjectKey));

  const pairs = rows.map((row) => {
    const [userA = '', userB = ''] = row.subjectKey.split(':');
    return { userA, userB, dismissedAt: row.createdAt.toISOString() };
  });
  const identities = await loadMergeIdentities([
    ...new Set(pairs.flatMap((p) => [p.userA, p.userB])),
  ]);

  const dismissed: DismissedMergeSuggestion[] = [];
  for (const { userA, userB, dismissedAt } of pairs) {
    const first = identities.get(userA);
    const second = identities.get(userB);
    if (first && second) dismissed.push({ users: [first, second], dismissedAt });
  }
  return dismissed;
}

export async function dismissMergeSuggestion(
  userIds: [string, string],
  actingUserId: string
): Promise<void> {
  const found = await db.select({ id: users.id }).from(users).where(inArray(users.id, userIds));
  const missing = userIds.find((id) => !found.some((u) => u.id === id.toLowerCase()));
  if (missing) throw new UserNotFoundError(missing);

  await db
    .insert(dismissals)
    .values({
      kind: 'merge_suggestion',
      subjectKey: mergeSuggestionKey(...userIds),
      dismissedByUserId: actingUserId,
    })
    .onConflictDoNothing({ target: [dismissals.kind, dismissals.subjectKey] });
}

export async function restoreMergeSuggestion(userA: string, userB: string): Promise<void> {
  await db
    .delete(dismissals)
    .where(
      and(
        eq(dismissals.kind, 'merge_suggestion'),
        eq(dismissals.subjectKey, mergeSuggestionKey(userA, userB))
      )
    );
}
