import { desc, eq, inArray } from 'drizzle-orm';
import type { EmailSuppression, EmailSuppressionReason } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { emailSuppressions } from '../../db/schema.js';

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export async function listSuppressions(): Promise<EmailSuppression[]> {
  const rows = await db.select().from(emailSuppressions).orderBy(desc(emailSuppressions.createdAt));
  return rows.map((row) => ({
    address: row.address,
    reason: row.reason,
    sourceSendId: row.sourceSendId,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Idempotent: an address already on the list keeps its first reason and source. */
export async function addSuppression(
  address: string,
  reason: EmailSuppressionReason,
  sourceSendId: string | null = null
): Promise<void> {
  await db
    .insert(emailSuppressions)
    .values({ address: normalizeAddress(address), reason, sourceSendId })
    .onConflictDoNothing();
}

export async function removeSuppression(address: string): Promise<boolean> {
  const rows = await db
    .delete(emailSuppressions)
    .where(eq(emailSuppressions.address, normalizeAddress(address)))
    .returning({ address: emailSuppressions.address });
  return rows.length > 0;
}

export async function suppressedAmong(addresses: string[]): Promise<Set<string>> {
  const wanted = [...new Set(addresses.map(normalizeAddress))];
  if (wanted.length === 0) return new Set();
  const rows = await db
    .select({ address: emailSuppressions.address })
    .from(emailSuppressions)
    .where(inArray(emailSuppressions.address, wanted));
  return new Set(rows.map((row) => row.address));
}
