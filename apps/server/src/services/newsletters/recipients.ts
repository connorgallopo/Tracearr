import { sql } from 'drizzle-orm';
import type { NewsletterRecipients, NewsletterScope } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { normalizeAddress, suppressedAmong } from './suppressions.js';

export interface RecipientCandidate {
  userId: string;
  name: string | null;
  contactEmail: string | null;
  identityEmail: string | null;
  accountEmails: string[];
}

export interface ResolvedRecipient {
  address: string;
  userId: string | null;
  name: string | null;
  suppressed: boolean;
}

export interface RecipientResolution {
  recipients: ResolvedRecipient[];
  missingEmail: number;
}

function firstAddress(candidate: RecipientCandidate): string | null {
  const raw =
    candidate.contactEmail ?? candidate.identityEmail ?? candidate.accountEmails[0] ?? null;
  return raw ? normalizeAddress(raw) : null;
}

/** Identities first, in the order given; hand-typed extras after; one row per address. */
export function mergeRecipients(
  candidates: RecipientCandidate[],
  extras: { address: string; name?: string }[],
  suppressed: Set<string>
): RecipientResolution {
  const seen = new Set<string>();
  const recipients: ResolvedRecipient[] = [];
  let missingEmail = 0;
  for (const candidate of candidates) {
    const address = firstAddress(candidate);
    if (!address) {
      missingEmail += 1;
      continue;
    }
    if (seen.has(address)) continue;
    seen.add(address);
    recipients.push({
      address,
      userId: candidate.userId,
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
      name: extra.name ?? null,
      suppressed: suppressed.has(address),
    });
  }
  return { recipients, missingEmail };
}

interface CandidateRow {
  user_id: string;
  name: string | null;
  contact_email: string | null;
  identity_email: string | null;
  account_emails: string[] | null;
}

/** One row per identity with an active account on a scoped server; disabled identities never receive mail. */
export async function loadCandidates(serverIds: string[]): Promise<RecipientCandidate[]> {
  const scope = serverIds.length === 0 ? sql`` : sql`AND su.server_id IN ${serverIds}`;
  const result = await db.execute(sql`
    SELECT u.id AS user_id,
           u.name,
           u.contact_email,
           u.email AS identity_email,
           array_remove(array_agg(su.email), NULL) AS account_emails
    FROM users u
    JOIN server_users su ON su.user_id = u.id AND su.removed_at IS NULL
    WHERE u.role <> 'disabled' ${scope}
    GROUP BY u.id
    ORDER BY u.created_at, u.id
  `);
  return (result.rows as unknown as CandidateRow[]).map((row) => ({
    userId: row.user_id,
    name: row.name,
    contactEmail: row.contact_email,
    identityEmail: row.identity_email,
    accountEmails: row.account_emails ?? [],
  }));
}

export async function resolveRecipients(newsletter: {
  scope: NewsletterScope;
  recipients: NewsletterRecipients;
}): Promise<RecipientResolution> {
  const candidates = newsletter.recipients.members
    ? await loadCandidates(newsletter.scope.serverIds)
    : [];
  const addresses = [
    ...candidates.map(firstAddress).filter((a): a is string => a !== null),
    ...newsletter.recipients.extraAddresses.map((e) => e.address),
  ];
  const suppressed = await suppressedAmong(addresses);
  return mergeRecipients(candidates, newsletter.recipients.extraAddresses, suppressed);
}
