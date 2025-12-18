/**
 * Cleanup job for expired/used mobile pairing tokens
 *
 * Run via cron or BullMQ scheduler to periodically clean up:
 * - Expired unused tokens (older than 1 hour)
 * - Used tokens (older than 30 days)
 */

import { lt, and, isNull, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { mobileTokens } from '../db/schema.js';

export async function cleanupMobileTokens(): Promise<{ deleted: number }> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Delete expired unused tokens older than 1 hour
  const expiredResult = await db
    .delete(mobileTokens)
    .where(and(lt(mobileTokens.expiresAt, oneHourAgo), isNull(mobileTokens.usedAt)))
    .returning({ id: mobileTokens.id });

  // Delete used tokens older than 30 days
  const usedResult = await db
    .delete(mobileTokens)
    .where(and(isNotNull(mobileTokens.usedAt), lt(mobileTokens.usedAt, thirtyDaysAgo)))
    .returning({ id: mobileTokens.id });

  return { deleted: expiredResult.length + usedResult.length };
}
