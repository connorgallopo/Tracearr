import { sql } from 'drizzle-orm';
import type {
  NewsletterExcludedPerson,
  NewsletterRecipientPerson,
  NewsletterRecipients,
  NewsletterScope,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { lastDeliveredUserIds } from './store.js';
import { normalizeAddress, suppressedAmong } from './suppressions.js';

export interface RecipientCandidate {
  userId: string;
  /** The oldest account on a scoped server; the identity PATCH route keys on it. */
  serverUserId: string;
  name: string | null;
  /** Username, server and avatar of that same oldest account. */
  username: string | null;
  serverId: string;
  serverName: string;
  thumbUrl: string | null;
  /** Every scoped server the identity has an active account on, oldest first. */
  serverIds: string[];
  contactEmail: string | null;
  identityEmail: string | null;
  /** Plex accounts first: theirs are real emails, a Jellyfin or Emby one is a username. */
  accountEmails: string[];
  /** No Plex account has an email, so any account email is a Jellyfin or Emby username. */
  accountEmailsFromUsernames: boolean;
  /** Banned or pending identities stay on the list as excluded so the owner sees why a name is missing. */
  blocked: 'banned' | 'pending' | null;
}

export interface ResolvedRecipient {
  address: string;
  userId: string | null;
  serverUserId: string | null;
  name: string | null;
  suppressed: boolean;
  serverId: string | null;
  username: string | null;
  serverName: string | null;
  thumbUrl: string | null;
  serverIds: string[];
  newSinceLastSend: boolean;
  addressFromUsername: boolean;
}

export interface RecipientResolution {
  recipients: ResolvedRecipient[];
  missing: NewsletterRecipientPerson[];
  excluded: NewsletterExcludedPerson[];
}

function firstAddress(candidate: RecipientCandidate): string | null {
  const raw =
    candidate.contactEmail ?? candidate.identityEmail ?? candidate.accountEmails[0] ?? null;
  return raw ? normalizeAddress(raw) : null;
}

const person = (candidate: RecipientCandidate): NewsletterRecipientPerson => ({
  userId: candidate.userId,
  serverUserId: candidate.serverUserId,
  name: candidate.name,
  username: candidate.username,
  serverId: candidate.serverId,
  serverName: candidate.serverName,
  thumbUrl: candidate.thumbUrl,
  serverIds: candidate.serverIds,
});

/** Identities first, in the order given; hand-typed extras after; one row per address, which keeps the first identity and gains the servers of any later one sharing it. Excluded identities are set aside before addressing. */
export function mergeRecipients(
  candidates: RecipientCandidate[],
  extras: { address: string; name?: string }[],
  suppressed: Set<string>,
  excludeUserIds: readonly string[] = []
): RecipientResolution {
  const excludedIds = new Set(excludeUserIds);
  const byAddress = new Map<string, ResolvedRecipient>();
  const recipients: ResolvedRecipient[] = [];
  const missing: NewsletterRecipientPerson[] = [];
  const excluded: NewsletterExcludedPerson[] = [];
  for (const candidate of candidates) {
    if (candidate.blocked) {
      excluded.push({ ...person(candidate), reason: candidate.blocked });
      continue;
    }
    if (excludedIds.has(candidate.userId)) {
      excluded.push({ ...person(candidate), reason: 'excluded' });
      continue;
    }
    const address = firstAddress(candidate);
    if (!address) {
      missing.push(person(candidate));
      continue;
    }
    const kept = byAddress.get(address);
    if (kept) {
      for (const serverId of candidate.serverIds) {
        if (!kept.serverIds.includes(serverId)) kept.serverIds.push(serverId);
      }
      continue;
    }
    const recipient: ResolvedRecipient = {
      address,
      userId: candidate.userId,
      serverUserId: candidate.serverUserId,
      name: candidate.name,
      suppressed: suppressed.has(address),
      username: candidate.username,
      serverId: candidate.serverId,
      serverName: candidate.serverName,
      thumbUrl: candidate.thumbUrl,
      serverIds: [...candidate.serverIds],
      newSinceLastSend: false,
      addressFromUsername:
        candidate.contactEmail === null &&
        candidate.identityEmail === null &&
        candidate.accountEmailsFromUsernames,
    };
    byAddress.set(address, recipient);
    recipients.push(recipient);
  }
  for (const extra of extras) {
    const address = normalizeAddress(extra.address);
    if (byAddress.has(address)) continue;
    const recipient: ResolvedRecipient = {
      address,
      userId: null,
      serverUserId: null,
      name: extra.name ?? null,
      suppressed: suppressed.has(address),
      username: null,
      serverId: null,
      serverName: null,
      thumbUrl: null,
      serverIds: [],
      newSinceLastSend: false,
      addressFromUsername: false,
    };
    byAddress.set(address, recipient);
    recipients.push(recipient);
  }
  return { recipients, missing, excluded };
}

interface CandidateRow {
  user_id: string;
  server_user_id: string;
  name: string | null;
  contact_email: string | null;
  identity_email: string | null;
  account_emails: string[] | null;
  account_emails_from_usernames: boolean;
  usernames: string[] | null;
  server_ids: string[] | null;
  server_names: string[] | null;
  thumb_urls: (string | null)[] | null;
  blocked: 'banned' | 'pending' | null;
}

/** One row per identity with an active account on a scoped server; disabled identities never receive mail, banned and pending ones are reported. */
export async function loadCandidates(serverIds: string[]): Promise<RecipientCandidate[]> {
  const scope = serverIds.length === 0 ? sql`` : sql`AND su.server_id IN ${serverIds}`;
  const result = await db.execute(sql`
    SELECT u.id AS user_id,
           (array_agg(su.id ORDER BY su.created_at, su.id))[1] AS server_user_id,
           u.name,
           u.contact_email,
           u.email AS identity_email,
           array_remove(array_agg(su.email ORDER BY s.type <> 'plex', su.created_at, su.id), NULL) AS account_emails,
           bool_and(su.email IS NULL OR s.type <> 'plex') AS account_emails_from_usernames,
           array_agg(su.username ORDER BY su.created_at, su.id) AS usernames,
           array_agg(su.server_id ORDER BY su.created_at, su.id) AS server_ids,
           array_agg(s.name ORDER BY su.created_at, su.id) AS server_names,
           array_agg(su.thumb_url ORDER BY su.created_at, su.id) AS thumb_urls,
           CASE WHEN u.banned IS TRUE THEN 'banned' WHEN u.role = 'pending' THEN 'pending' END AS blocked
    FROM users u
    JOIN server_users su ON su.user_id = u.id AND su.removed_at IS NULL
    JOIN servers s ON s.id = su.server_id
    WHERE u.role <> 'disabled' ${scope}
    GROUP BY u.id
    ORDER BY u.created_at, u.id
  `);
  return (result.rows as unknown as CandidateRow[]).map((row) => ({
    userId: row.user_id,
    serverUserId: row.server_user_id,
    name: row.name,
    username: row.usernames?.[0] ?? null,
    serverId: row.server_ids?.[0] ?? '',
    serverName: row.server_names?.[0] ?? '',
    thumbUrl: row.thumb_urls?.[0] ?? null,
    serverIds: row.server_ids ?? [],
    contactEmail: row.contact_email,
    identityEmail: row.identity_email,
    accountEmails: row.account_emails ?? [],
    accountEmailsFromUsernames: row.account_emails_from_usernames,
    blocked: row.blocked ?? null,
  }));
}

/** newSinceLastSend stays false unless the saved newsletter's id is passed; the send pipeline and previews skip that lookup. */
export async function resolveRecipients(
  newsletter: {
    scope: NewsletterScope;
    recipients: NewsletterRecipients;
  },
  newSinceLastSendOf?: string
): Promise<RecipientResolution> {
  const { members, extraAddresses, excludeUserIds } = newsletter.recipients;
  const candidates = members ? await loadCandidates(newsletter.scope.serverIds) : [];
  const excludedIds = new Set(excludeUserIds);
  const addresses = [
    ...candidates
      .filter((candidate) => !candidate.blocked && !excludedIds.has(candidate.userId))
      .map(firstAddress)
      .filter((a): a is string => a !== null),
    ...extraAddresses.map((e) => normalizeAddress(e.address)),
  ];
  const [suppressed, reached] = await Promise.all([
    suppressedAmong(addresses),
    members && newSinceLastSendOf !== undefined ? lastDeliveredUserIds(newSinceLastSendOf) : null,
  ]);
  const resolution = mergeRecipients(candidates, extraAddresses, suppressed, excludeUserIds);
  if (!reached) return resolution;
  return {
    ...resolution,
    recipients: resolution.recipients.map((r) =>
      r.userId !== null && !reached.has(r.userId) ? { ...r, newSinceLastSend: true } : r
    ),
  };
}
