import {
  variantKey,
  variantServerIds,
  type NewsletterExcludedPerson,
  type NewsletterRecipientPerson,
  type NewsletterRecipientsView,
  type NewsletterResolvedRecipient,
} from '@tracearr/shared';

export interface RecipientPartition {
  receive: NewsletterResolvedRecipient[];
  /** On the suppression list; the send records them as suppressed and mails nothing. */
  suppressed: NewsletterResolvedRecipient[];
  missing: NewsletterRecipientPerson[];
  /** Taken off by the owner, so Include can bring them back. */
  excluded: NewsletterExcludedPerson[];
  /** Banned, pending, or on none of the chosen servers: listed, never includable. */
  notIncludable: NewsletterExcludedPerson[];
}

export function partitionRecipients(view: NewsletterRecipientsView): RecipientPartition {
  return {
    receive: view.recipients.filter((r) => !r.suppressed),
    suppressed: view.recipients.filter((r) => r.suppressed),
    missing: view.missing,
    excluded: view.excluded.filter((p) => p.reason === 'excluded'),
    notIncludable: view.excluded.filter((p) => p.reason !== 'excluded'),
  };
}

export type PendingChange = 'excluded' | 'included' | null;

/** The view already answers for the form, so what waits for Save is the form's exclusions measured against the saved row's. */
export function pendingChange(
  userId: string | null,
  excludeUserIds: readonly string[],
  savedExcludeUserIds: readonly string[]
): PendingChange {
  if (userId === null) return null;
  const excludedNow = excludeUserIds.includes(userId);
  if (excludedNow === savedExcludeUserIds.includes(userId)) return null;
  return excludedNow ? 'excluded' : 'included';
}

export type RecipientEntry =
  | { kind: 'recipient'; key: string; row: NewsletterResolvedRecipient }
  | { kind: 'missing'; key: string; person: NewsletterRecipientPerson }
  | { kind: 'excluded'; key: string; person: NewsletterExcludedPerson };

export const recipientEntry = (row: NewsletterResolvedRecipient): RecipientEntry => ({
  kind: 'recipient',
  key: row.userId ?? row.address,
  row,
});

export const missingEntry = (person: NewsletterRecipientPerson): RecipientEntry => ({
  kind: 'missing',
  key: person.userId,
  person,
});

export const excludedEntry = (person: NewsletterExcludedPerson): RecipientEntry => ({
  kind: 'excluded',
  key: person.userId,
  person,
});

export const entryUserId = (entry: RecipientEntry): string | null =>
  entry.kind === 'recipient' ? entry.row.userId : entry.person.userId;

/** Who a bulk action can move: a member on the list can be excluded and an owner exclusion included; nobody else. */
export function selectableId(entry: RecipientEntry): string | null {
  switch (entry.kind) {
    case 'recipient':
      return entry.row.userId;
    case 'excluded':
      return entry.person.reason === 'excluded' ? entry.person.userId : null;
    case 'missing':
      return null;
  }
}

export const SUMMARY_ROWS = 8;

/** The card's rows: people new since the last send, people with no address, then unsaved changes; the first receivers when none of those apply. */
export function summaryEntries(
  partition: RecipientPartition,
  pending: (userId: string | null) => PendingChange
): RecipientEntry[] {
  const listed = [...partition.receive, ...partition.suppressed];
  const attention = [
    ...listed.filter((r) => r.newSinceLastSend).map(recipientEntry),
    ...partition.missing.map(missingEntry),
    ...listed.filter((r) => pending(r.userId) !== null).map(recipientEntry),
    ...partition.excluded.filter((p) => pending(p.userId) !== null).map(excludedEntry),
  ];
  const seen = new Set<string>();
  const unique = attention.filter((entry) => {
    if (seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  });
  return (unique.length > 0 ? unique : partition.receive.map(recipientEntry)).slice(
    0,
    SUMMARY_ROWS
  );
}

export function matchesSearch(entry: RecipientEntry, search: string | undefined): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  const person = entry.kind === 'recipient' ? entry.row : entry.person;
  const address = entry.kind === 'recipient' ? entry.row.address : null;
  return [person.name, person.username, address].some(
    (value) => value !== null && value.toLowerCase().includes(needle)
  );
}

/** The scoped servers whose version a row gets: the ones it has an account on, or every one for an extra address or a member matching none. */
function rowVariant(
  row: { userId: string | null; serverIds: string[] },
  scopedIds: readonly string[]
): string[] {
  const matched = variantServerIds(row.userId === null ? null : row.serverIds, scopedIds);
  return matched.length === 0 ? [...scopedIds] : matched;
}

export function entryOnServer(
  entry: RecipientEntry,
  serverId: string,
  scopedIds: readonly string[]
): boolean {
  return rowVariant(entry.kind === 'recipient' ? entry.row : entry.person, scopedIds).includes(
    serverId
  );
}

export interface VariantGroup<T> {
  key: string;
  serverNames: string[];
  rows: T[];
}

/** Rows under the set of scoped servers each belongs to, the union first. */
export function groupByVariant<T extends { userId: string | null; serverIds: string[] }>(
  rows: readonly T[],
  servers: readonly { id: string; name: string }[]
): VariantGroup<T>[] {
  const all = servers.map((s) => s.id);
  const unionKey = variantKey(all);
  const groups = new Map<string, VariantGroup<T>>();
  for (const row of rows) {
    const ids = rowVariant(row, all);
    const key = variantKey(ids);
    const group = groups.get(key) ?? {
      key,
      serverNames: servers.filter((s) => ids.includes(s.id)).map((s) => s.name),
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) =>
    a.key === unionKey ? -1 : b.key === unionKey ? 1 : a.key.localeCompare(b.key)
  );
}
