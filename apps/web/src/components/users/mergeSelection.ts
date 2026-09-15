import {
  rankMergeTarget,
  type MergeRankInput,
  type MergeSuggestion,
  type MergeSuggestionIdentity,
  type ServerUserWithIdentity,
} from '@tracearr/shared';
import { getIdentityServers } from './identityServerPills';
import { getPersonRemovedState } from './removedStatus';

/**
 * Pure helpers for the Users page merge flows: the bulk action and suggestion review.
 */

interface MergeSelectableRow {
  userId: string;
}

export type MergeDisableReasonKey =
  | 'pages:users.mergeSelectAllActive'
  | 'pages:users.mergeSelectTwo'
  | 'pages:users.mergeSameIdentity';

export interface MergeActionState {
  disabled: boolean;
  reasonKey?: MergeDisableReasonKey;
}

/**
 * `selectedRows` carries every picked row, including ones from pages that are no
 * longer loaded, so its length is the selection count.
 */
export function deriveMergeActionState(
  selectedRows: MergeSelectableRow[],
  selectAllMode: boolean
): MergeActionState {
  if (selectAllMode) {
    return { disabled: true, reasonKey: 'pages:users.mergeSelectAllActive' };
  }
  if (selectedRows.length !== 2) {
    return { disabled: true, reasonKey: 'pages:users.mergeSelectTwo' };
  }
  const [first, second] = selectedRows;
  if (first?.userId === second?.userId) {
    return { disabled: true, reasonKey: 'pages:users.mergeSameIdentity' };
  }
  return { disabled: false };
}

interface ServerUserOverlapCandidate {
  serverId: string;
  serverName: string;
}

export function findOverlappingServerName(
  first: ServerUserOverlapCandidate[],
  second: ServerUserOverlapCandidate[]
): string | null {
  const overlap = first.find((su) => second.some((other) => other.serverId === su.serverId));
  return overlap?.serverName ?? null;
}

export interface MergeCandidateAccount {
  id: string;
  serverId: string;
  serverName: string;
  removedAt: string | null;
}

export interface MergeCandidate {
  userId: string;
  displayName: string;
  username: string;
  emails: string[];
  loginCapable: boolean;
  lastActivityAt: string | null;
  /** Absent for roster rows, which carry no session count. */
  sessionCount?: number;
  serverUsers: MergeCandidateAccount[];
}

export interface MergeMatch {
  type: MergeSuggestion['matchType'];
  value: string;
  /** An email match where the address is some account's Jellyfin or Emby username. */
  onUsername: boolean;
}

export interface MergeRequest {
  candidates: [MergeCandidate, MergeCandidate];
  defaultTargetUserId: string;
  requiredTargetUserId: string | null;
  /** Why a suggestion paired the two; null when the owner picked them from the roster. */
  match: MergeMatch | null;
  /** Both identities have an account on one server, which the merge fuses for good. */
  sameServer: { serverName: string | null } | null;
}

export const isEmailMatchOnUsername = ({ matchType, matchValue, users }: MergeSuggestion) =>
  matchType === 'email' &&
  users.some((u) => u.serverUsers.some((su) => su.username.toLowerCase() === matchValue));

export function identityDisplayName(identity: Pick<MergeSuggestionIdentity, 'name' | 'username'>) {
  return identity.name ?? identity.username;
}

// Roster dates arrive as JSON strings despite the Date typing, so never call Date methods on them directly.
function toIsoString(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function uniqueEmails(emails: (string | null | undefined)[]): string[] {
  const byLowercase = new Map<string, string>();
  for (const email of emails) {
    if (email && !byLowercase.has(email.toLowerCase())) byLowercase.set(email.toLowerCase(), email);
  }
  return [...byLowercase.values()];
}

export function identityToMergeCandidate(identity: MergeSuggestionIdentity): MergeCandidate {
  return {
    userId: identity.userId,
    displayName: identityDisplayName(identity),
    username: identity.username,
    emails: uniqueEmails([identity.email, ...identity.serverUsers.map((su) => su.email)]),
    loginCapable: identity.loginCapable,
    lastActivityAt: identity.lastActivityAt,
    sessionCount: identity.sessionCount,
    serverUsers: identity.serverUsers.map(({ id, serverId, serverName, removedAt }) => ({
      id,
      serverId,
      serverName,
      removedAt,
    })),
  };
}

export function rowToMergeCandidate(row: ServerUserWithIdentity): MergeCandidate {
  const ownRemovedAt = toIsoString(row.removedAt);
  return {
    userId: row.userId,
    displayName: row.identityName ?? row.username,
    username: row.username,
    emails: uniqueEmails([row.email]),
    // Server-computed: role alone misses a linked Plex or auth account, and the
    // dialog would then offer a direction the server rejects.
    loginCapable: row.loginCapable ?? false,
    lastActivityAt: toIsoString(row.identityLastActivityAt),
    serverUsers: getIdentityServers(row.identityServers, {
      id: row.serverId,
      name: row.serverName,
      serverUserId: row.id,
      removedAt: ownRemovedAt,
    }).map((server) => ({
      id: server.serverUserId ?? (server.id === row.serverId ? row.id : server.id),
      serverId: server.id,
      serverName: server.name,
      removedAt: server.removedAt ?? (server.id === row.serverId ? ownRemovedAt : null),
    })),
  };
}

function rankInput(candidate: MergeCandidate): MergeRankInput {
  return {
    userId: candidate.userId,
    loginCapable: candidate.loginCapable,
    removed: getPersonRemovedState(candidate.serverUsers).removed,
    lastActivityAt: candidate.lastActivityAt,
    sessionCount: candidate.sessionCount ?? 0,
  };
}

export function mergeRequestFromSuggestion(suggestion: MergeSuggestion): MergeRequest {
  const [first, second] = suggestion.users;
  return {
    candidates: [identityToMergeCandidate(first), identityToMergeCandidate(second)],
    defaultTargetUserId: suggestion.suggestedTargetUserId,
    requiredTargetUserId: suggestion.requiredTargetUserId,
    match: {
      type: suggestion.matchType,
      value: suggestion.matchValue,
      onUsername: isEmailMatchOnUsername(suggestion),
    },
    sameServer: suggestion.wouldCombineSameServer
      ? { serverName: findOverlappingServerName(first.serverUsers, second.serverUsers) }
      : null,
  };
}

export function mergeRequestFromRows(
  first: ServerUserWithIdentity,
  second: ServerUserWithIdentity
): MergeRequest {
  const a = rowToMergeCandidate(first);
  const b = rowToMergeCandidate(second);
  return {
    candidates: [a, b],
    defaultTargetUserId: rankMergeTarget(rankInput(a), rankInput(b)),
    requiredTargetUserId: a.loginCapable ? a.userId : b.loginCapable ? b.userId : null,
    match: null,
    sameServer: first.serverId === second.serverId ? { serverName: first.serverName } : null,
  };
}

/** The server rejected a merge as a same-server combine the client did not predict. */
export function withSameServerCombine(request: MergeRequest): MergeRequest {
  if (request.sameServer) return request;
  const [first, second] = request.candidates;
  return {
    ...request,
    sameServer: { serverName: findOverlappingServerName(first.serverUsers, second.serverUsers) },
  };
}
