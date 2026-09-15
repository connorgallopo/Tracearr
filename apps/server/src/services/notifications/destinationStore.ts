import { and, eq } from 'drizzle-orm';
import {
  DESTINATION_TYPES,
  destinationConfigSchema,
  WS_EVENTS,
  type Destination,
  type DestinationKind,
  type NotificationEventType,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { destinations } from '../../db/schema.js';
import { createLogger } from '../../utils/logger.js';
import { getPubSubService } from '../cache.js';
import { decryptConfig, encryptConfig, type DecryptResult } from './destinationCrypto.js';

const logger = createLogger('destinations');
export type DestinationRow = typeof destinations.$inferSelect;

/** Pub/sub invalidation is the primary signal; the TTL only covers a missed message. */
const CACHE_TTL_MS = 5 * 60_000;
let cache: { rows: DestinationRow[]; expiresAt: number } | null = null;

export function invalidateDestinationsCache(): void {
  cache = null;
}

export async function publishDestinationsChanged(): Promise<void> {
  invalidateDestinationsCache();
  await getPubSubService()
    ?.publish(WS_EVENTS.DESTINATIONS_CHANGED, {})
    .catch((error: unknown) => {
      logger.warn(
        'destinations:changed publish failed; other instances fall back to the cache TTL',
        { error }
      );
    });
}

export async function listDestinations(): Promise<DestinationRow[]> {
  if (cache && cache.expiresAt > Date.now()) return [...cache.rows];
  const rows = await db
    .select()
    .from(destinations)
    .orderBy(destinations.createdAt, destinations.id);
  cache = { rows, expiresAt: Date.now() + CACHE_TTL_MS };
  return [...rows];
}

export async function getDestination(id: string): Promise<DestinationRow | null> {
  return (await listDestinations()).find((d) => d.id === id) ?? null;
}

export async function findDestinationsForEvent(
  eventType: NotificationEventType
): Promise<DestinationRow[]> {
  return (await listDestinations()).filter(
    (d) => d.enabled && d.configStatus === 'ok' && d.events.includes(eventType)
  );
}

export function readConfig(row: DestinationRow): DecryptResult {
  if (row.config === null) return { ok: true, config: {}, rewrap: false };
  return decryptConfig(row.config);
}

export function toPublicDestination(
  row: DestinationRow,
  referencedByAutomationCount: number,
  referencedByNewsletterCount: number
): Destination {
  const descriptor = DESTINATION_TYPES[row.type];
  const secretKeys = descriptor.fields.filter((f) => f.secret).map((f) => f.key);
  let config: Destination['config'] = null;
  let secretsSet: string[] = [];
  let configStatus = row.configStatus;
  if (row.configStatus === 'ok' && !row.builtin) {
    const opened = readConfig(row);
    if (opened.ok) {
      config = {};
      for (const f of descriptor.fields) {
        const v = opened.config[f.key];
        config[f.key] = f.secret ? null : typeof v === 'string' ? v : null;
      }
      secretsSet = secretKeys.filter(
        (k) => typeof opened.config[k] === 'string' && opened.config[k] !== ''
      );
    } else {
      // The row only flips to reencrypt on the next boot sweep; reporting ok would offer a test that cannot run.
      configStatus = 'reencrypt';
    }
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    builtin: row.builtin,
    events: row.events,
    configStatus,
    config,
    secretsSet,
    referencedByAutomationCount,
    referencedByNewsletterCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createDestination(input: {
  name: string;
  type: DestinationKind;
  config: Record<string, unknown>;
  events: NotificationEventType[];
  enabled: boolean;
}): Promise<DestinationRow> {
  const [row] = await db
    .insert(destinations)
    .values({
      name: input.name,
      type: input.type,
      config: encryptConfig(input.config),
      events: input.events,
      enabled: input.enabled,
    })
    .returning();
  if (!row) throw new Error('insert returned no row');
  await publishDestinationsChanged();
  return row;
}

/** Secrets: omitted keeps, null clears, string replaces. Non-secret fields follow the same rule; the route validates the merged object. */
export async function updateDestination(
  id: string,
  patch: {
    name?: string;
    config?: Record<string, string | null>;
    events?: NotificationEventType[];
    enabled?: boolean;
  }
): Promise<DestinationRow> {
  // Merge against the row, not the cache: another instance's write may not have invalidated here yet.
  const [current] = await db.select().from(destinations).where(eq(destinations.id, id)).limit(1);
  if (!current) throw new Error('destination not found');
  const set: Partial<typeof destinations.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.events !== undefined) set.events = patch.events;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.config !== undefined && !current.builtin) {
    const opened = readConfig(current);
    const base = opened.ok ? opened.config : {};
    const merged: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch.config)) {
      if (v === null) Reflect.deleteProperty(merged, k);
      else merged[k] = v;
    }
    // The route validated its own merge from the cache; re-check against the row so a stale cache never persists an incomplete config.
    const check = destinationConfigSchema(current.type).safeParse(merged);
    if (!check.success)
      throw new Error(
        `config incomplete after merge: ${check.error.issues[0]?.message ?? 'invalid'}`
      );
    set.config = encryptConfig(check.data);
    set.configStatus = 'ok';
  }
  const [row] = await db.update(destinations).set(set).where(eq(destinations.id, id)).returning();
  if (!row) throw new Error('destination not found');
  await publishDestinationsChanged();
  return row;
}

export async function deleteDestination(id: string): Promise<boolean> {
  const deleted = await db
    .delete(destinations)
    .where(and(eq(destinations.id, id), eq(destinations.builtin, false)))
    .returning();
  await publishDestinationsChanged();
  return deleted.length > 0;
}

/** Called by the worker when a row fails to decrypt; the UI shows "re-enter" and the dispatcher skips it. */
export async function markReencrypt(id: string): Promise<void> {
  await db
    .update(destinations)
    .set({ configStatus: 'reencrypt', updatedAt: new Date() })
    .where(eq(destinations.id, id));
  await publishDestinationsChanged();
}

/** Rewrap a row that opened under the secondary key so it stops depending on it. */
export async function rewrapConfig(id: string, config: Record<string, unknown>): Promise<void> {
  await db
    .update(destinations)
    .set({ config: encryptConfig(config), updatedAt: new Date() })
    .where(eq(destinations.id, id));
  invalidateDestinationsCache();
}
