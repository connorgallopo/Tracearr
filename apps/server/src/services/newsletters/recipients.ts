import { sql } from 'drizzle-orm';
import type {
  NewsletterExcludedPerson,
  NewsletterExcludedReason,
  NewsletterRecipientPerson,
  NewsletterRecipients,
  NewsletterScope,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { normalizeAddress, suppressedAmong } from './suppressions.js';

export interface RecipientCandidate {
  userId: string;
  /** The oldest account on a scoped server; the identity PATCH route keys on it. */
  serverUserId: string;
  name: string | null;
  contactEmail: string | null;
  identityEmail: string | null;
  accountEmails: string[];
  /** Banned or pending identities stay on the list as excluded so the owner sees why a name is missing. */
  blocked: Exclude<NewsletterExcludedReason, 'excluded'> | null;
}

export interface ResolvedRecipient {
  address: string;
  userId: string | null;
  serverUserId: string | null;
  name: string | null;
  suppressed: boolean;
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
});

/** Identities first, in the order given; hand-typed extras after; one row per address. Excluded identities are set aside before addressing. */
export function mergeRecipients(
  candidates: RecipientCandidate[],
  extras: { address: string; name?: string }[],
  suppressed: Set<string>,
  excludeUserIds: readonly string[] = []
): RecipientResolution {
  const excludedIds = new Set(excludeUserIds);
  const seen = new Set<string>();
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
    if (seen.has(address)) continue;
    seen.add(address);
    recipients.push({
      address,
      userId: candidate.userId,
      serverUserId: candidate.serverUserId,
      name: candidate.name,
      suppressed: suppressed.has(address),
    });
  }
  for (const extra of extras) {
    const address = normalizeAddress(extra.address);
    if (seen.has(address)) continue;
    seen.add(address);
    recipients.push({
      address,
      userId: null,
      serverUserId: null,
      name: extra.name ?? null,
      suppressed: suppressed.has(address),
    });
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
           array_remove(array_agg(su.email ORDER BY su.created_at, su.id), NULL) AS account_emails,
           CASE WHEN u.banned IS TRUE THEN 'banned' WHEN u.role = 'pending' THEN 'pending' END AS blocked
    FROM users u
    JOIN server_users su ON su.user_id = u.id AND su.removed_at IS NULL
    WHERE u.role <> 'disabled' ${scope}
    GROUP BY u.id
    ORDER BY u.created_at, u.id
  `);
  return (result.rows as unknown as CandidateRow[]).map((row) => ({
    userId: row.user_id,
    serverUserId: row.server_user_id,
    name: row.name,
    contactEmail: row.contact_email,
    identityEmail: row.identity_email,
    accountEmails: row.account_emails ?? [],
    blocked: row.blocked ?? null,
  }));
}

export async function resolveRecipients(newsletter: {
  scope: NewsletterScope;
  recipients: NewsletterRecipients;
}): Promise<RecipientResolution> {
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
  const suppressed = await suppressedAmong(addresses);
  return mergeRecipients(candidates, extraAddresses, suppressed, excludeUserIds);
}
