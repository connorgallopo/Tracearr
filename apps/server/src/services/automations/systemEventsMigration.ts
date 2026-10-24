/**
 * Destination checkboxes become automations, pause and inactivity thresholds move onto
 * their trigger nodes, and the columns the V1 model left behind go.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  SUBSCRIBABLE_EVENTS,
  type AutomationConditions,
  type NotificationEventType,
  type TriggerNode,
} from '@tracearr/shared';
import { db, type Executor } from '../../db/client.js';
import { automations, automationTemplates, destinations } from '../../db/schema.js';
import { invalidateAutomationsCache } from '../../jobs/poller/database.js';
import { createLogger } from '../../utils/logger.js';
import { publishDestinationsChanged } from '../notifications/destinationStore.js';
import { countPendingWork, hasLegacyColumns } from './modelMigration.js';
import { materializeInstance } from './templates/materialize.js';
import { getTemplate, instantiateTemplate } from './templates/store.js';
import {
  DEFAULT_HELD_FOR,
  DEFAULT_INACTIVE_FOR,
  heldForThresholds,
  inactiveForDays,
} from './triggers.js';
import { automationDefinition, canonicalEqual, insertAutomationVersion } from './versions.js';

const logger = createLogger('system-events-migration');

/** Distinct from destinations' 875_100_003, the model's 875_100_004 and the template seeder's 875_100_005. */
const LOCK_KEY = 875_100_006;

/** The subscription a destination used to carry, and the template that now delivers it. */
const EVENT_TEMPLATES: ReadonlyArray<readonly [NotificationEventType, string]> = [
  ['stream_started', 'stream-started'],
  ['stream_stopped', 'stream-ended'],
  ['server_down', 'server-down'],
  ['server_up', 'server-up'],
  ['plugin_update_available', 'plugin-update'],
  ['new_device', 'new-device'],
  ['trust_score_changed', 'trust-score-changed'],
];

const KEPT_EVENTS = sql.join(
  SUBSCRIBABLE_EVENTS.map((event) => sql`${event}`),
  sql`, `
);

/** A destination still subscribed to something an automation now owns. */
const LEGACY_SUBSCRIPTION = sql`EXISTS (
  SELECT 1 FROM jsonb_array_elements_text(events) AS event
  WHERE event NOT IN (${KEPT_EVENTS})
)`;

/** A node whose threshold never moved off the conditions; params it already carries are its own. */
const NEEDS_PARAMS = sql`triggers IS NOT NULL AND EXISTS (
  SELECT 1 FROM jsonb_array_elements(triggers) AS node
  WHERE node->>'type' IN ('session.held_for', 'account.inactive_for')
    AND node->'params' IS NULL
)`;

/**
 * `is_transcoding` took a boolean before it took a decision; both mean a stream state now.
 * A row still holding null triggers is left for the boot that stamps them.
 */
const BOOLEAN_TRANSCODE = sql`conditions IS NOT NULL AND triggers IS NOT NULL AND EXISTS (
  SELECT 1
  FROM jsonb_array_elements(conditions->'groups') AS grp,
       jsonb_array_elements(grp->'conditions') AS condition
  WHERE condition->>'field' = 'is_transcoding' AND jsonb_typeof(condition->'value') = 'boolean'
)`;

/**
 * Runs whose server the session or the account can still name. The session probe floors at a
 * minute below the stored start, as sessionRowById does; a run without one probes by id.
 */
const BACKFILLABLE_RUNS = sql`EXISTS (
  SELECT 1 FROM automation_runs r
  WHERE r.server_id IS NULL
    AND ((r.session_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM sessions s
          WHERE s.id = r.session_id
            AND (r.session_started_at IS NULL
              OR s.started_at >= r.session_started_at - interval '1 minute')))
      OR EXISTS (SELECT 1 FROM server_users su WHERE su.id = r.server_user_id))
)`;

/** Named per step, so a database that only owes one of them takes only that branch. */
interface PendingSteps {
  subscriptions: number;
  stamps: number;
  runs: boolean;
  dropLegacy: boolean;
  nullableTriggers: boolean;
}

interface MigrationSummary {
  seeded: number;
  cleared: number;
  stamped: number;
  runs: number;
  dropped: boolean;
  notNull: boolean;
}

const hasWork = (pending: PendingSteps): boolean =>
  pending.subscriptions > 0 ||
  pending.stamps > 0 ||
  pending.runs ||
  pending.dropLegacy ||
  pending.nullableTriggers;

const changedAnything = (summary: MigrationSummary): boolean =>
  summary.seeded > 0 ||
  summary.cleared > 0 ||
  summary.stamped > 0 ||
  summary.runs > 0 ||
  summary.dropped ||
  summary.notNull;

/**
 * The V1 columns go once the model migration's V1 pass has nothing left to read;
 * `triggers` takes its NOT NULL once no row holds a null.
 */
async function countPending(executor: Executor): Promise<PendingSteps> {
  const legacyColumns = await hasLegacyColumns(executor);
  const droppable = legacyColumns && (await countPendingWork(executor, true)).legacy === 0;
  const result = await executor.execute(sql`
    SELECT
      (SELECT count(*) FROM destinations WHERE ${LEGACY_SUBSCRIPTION})::int AS subscriptions,
      (SELECT count(*) FROM automations
        WHERE (${NEEDS_PARAMS}) OR (${BOOLEAN_TRANSCODE}))::int AS stamps,
      (${BACKFILLABLE_RUNS})::int AS runs,
      (SELECT NOT attnotnull FROM pg_attribute
        WHERE attrelid = 'automations'::regclass AND attname = 'triggers')::int AS nullable_triggers
  `);
  const row = result.rows[0];
  const count = (value: unknown): number => (typeof value === 'number' ? value : 0);
  return {
    subscriptions: count(row?.subscriptions),
    stamps: count(row?.stamps),
    runs: count(row?.runs) > 0,
    dropLegacy: droppable,
    nullableTriggers: count(row?.nullable_triggers) > 0,
  };
}

/** Every destination subscribed to the event, builtin or not, enabled or not. */
async function subscriberIds(tx: Executor, event: NotificationEventType): Promise<string[]> {
  const rows = await tx
    .select({ id: destinations.id })
    .from(destinations)
    .where(sql`events @> ${JSON.stringify([event])}::jsonb`)
    .orderBy(destinations.createdAt, destinations.id);
  return rows.map((row) => row.id);
}

/** One automation per event anyone was subscribed to, sending to exactly those destinations. */
async function seedEventAutomations(tx: Executor): Promise<number> {
  let seeded = 0;
  for (const [event, slug] of EVENT_TEMPLATES) {
    const to = await subscriberIds(tx, event);
    if (to.length === 0) continue;

    const [found] = await tx
      .select({ id: automationTemplates.id })
      .from(automationTemplates)
      .where(eq(automationTemplates.slug, slug));
    const template = found ? await getTemplate(found.id, tx) : null;
    if (!template) throw new Error(`builtin template ${slug} is missing`);

    const inputs = { to };
    const materialized = materializeInstance(template.version, inputs, template.name);
    if (!materialized.ok) throw new Error(`${slug} did not materialize: ${materialized.reason}`);

    await instantiateTemplate(
      tx,
      template,
      { definition: materialized.definition, inputs },
      { isActive: true }
    );
    seeded += 1;
  }
  return seeded;
}

/** A boolean transcode test becomes the decision it always meant. */
function normalizeTranscode(conditions: AutomationConditions | null): AutomationConditions | null {
  if (!conditions) return conditions;
  return {
    groups: conditions.groups.map((group) => ({
      ...group,
      conditions: group.conditions.map((condition) =>
        condition.field === 'is_transcoding' && typeof condition.value === 'boolean'
          ? { ...condition, value: condition.value ? 'video_or_audio' : 'neither' }
          : condition
      ),
    })),
  };
}

/** A node the union types with params can still be missing them, until this pass runs. */
const paramsOf = (node: TriggerNode): unknown => ('params' in node ? node.params : undefined);

/**
 * Every node keeps its id and its place. A params-less node takes the next threshold its
 * conditions imply, a threshold no node claimed becomes a node of its own, and a node with
 * nothing to take lands disabled.
 */
function stampParams(row: {
  id: string;
  triggers: TriggerNode[];
  conditions: AutomationConditions | null;
}): TriggerNode[] {
  const thresholds = heldForThresholds(row.conditions, row.id);
  const days = inactiveForDays(row.conditions, row.id);
  let taken = 0;

  const stamped = row.triggers.map((node): TriggerNode => {
    if (paramsOf(node) !== undefined) return node;
    if (node.type === 'session.held_for') {
      const params = thresholds[taken];
      if (!params) return { ...node, enabled: false, params: { ...DEFAULT_HELD_FOR } };
      taken += 1;
      return { ...node, params };
    }
    if (node.type === 'account.inactive_for') {
      return days === null
        ? { ...node, enabled: false, params: { ...DEFAULT_INACTIVE_FOR } }
        : { ...node, params: { days } };
    }
    return node;
  });

  const spare =
    taken === 0
      ? []
      : thresholds.slice(taken).map((params): TriggerNode => ({
          id: randomUUID(),
          type: 'session.held_for',
          enabled: true,
          params,
        }));
  return [...stamped, ...spare];
}

/**
 * The thresholds a pause or inactivity rule kept in its conditions move onto the nodes that
 * now test them. A row whose stored shape already says this writes nothing.
 */
async function stampTriggerParams(tx: Executor): Promise<number> {
  const rows = await tx
    .select({
      id: automations.id,
      triggers: automations.triggers,
      conditions: automations.conditions,
    })
    .from(automations)
    .where(sql`(${NEEDS_PARAMS}) OR (${BOOLEAN_TRANSCODE})`);

  let rewritten = 0;
  for (const row of rows) {
    const conditions = normalizeTranscode(row.conditions);
    const triggers = stampParams({ id: row.id, triggers: row.triggers, conditions });
    const stored = { triggers: row.triggers, conditions: row.conditions };
    if (canonicalEqual({ triggers, conditions }, stored)) continue;

    const [updated] = await tx
      .update(automations)
      .set({ triggers, conditions, updatedAt: new Date() })
      .where(eq(automations.id, row.id))
      .returning();
    if (!updated) continue;
    await insertAutomationVersion(tx, updated.id, automationDefinition(updated));
    rewritten += 1;
  }
  return rewritten;
}

/** The recorder stamps the server on every new run; the old ones read it back off their subject. */
async function backfillRunServers(tx: Executor): Promise<number> {
  const affected = async (query: Parameters<Executor['execute']>[0]): Promise<number> =>
    (await tx.execute(query)).rowCount ?? 0;

  const fromSessions = await affected(sql`
    UPDATE automation_runs AS r
    SET server_id = s.server_id
    FROM sessions s
    WHERE s.id = r.session_id AND r.server_id IS NULL
  `);
  const fromAccounts = await affected(sql`
    UPDATE automation_runs AS r
    SET server_id = su.server_id
    FROM server_users su
    WHERE su.id = r.server_user_id AND r.server_id IS NULL
  `);
  return fromSessions + fromAccounts;
}

/**
 * One transaction under an advisory lock; throws into boot recovery on failure.
 * Re-runs write nothing and log nothing.
 */
export async function runSystemEventsMigration(): Promise<void> {
  if (!hasWork(await countPending(db))) return;

  const summary = await db.transaction(async (tx): Promise<MigrationSummary | null> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
    const pending = await countPending(tx);
    if (!hasWork(pending)) return null;

    let seeded = 0;
    let cleared = 0;
    if (pending.subscriptions > 0) {
      seeded = await seedEventAutomations(tx);
      const stripped = await tx.execute(sql`
        UPDATE destinations
        SET events = COALESCE(
              (SELECT jsonb_agg(to_jsonb(event))
               FROM jsonb_array_elements_text(events) AS event
               WHERE event IN (${KEPT_EVENTS})),
              '[]'::jsonb),
            updated_at = now()
        WHERE ${LEGACY_SUBSCRIPTION}
      `);
      cleared = stripped.rowCount ?? 0;
    }

    const stamped = pending.stamps > 0 ? await stampTriggerParams(tx) : 0;
    const runs = pending.runs ? await backfillRunServers(tx) : 0;

    if (pending.dropLegacy) {
      await tx.execute(
        sql`ALTER TABLE automations DROP COLUMN IF EXISTS type, DROP COLUMN IF EXISTS params`
      );
    }

    // A rolling upgrade can still be writing null triggers; the constraint waits for the next boot.
    let notNull = false;
    if (pending.nullableTriggers) {
      const nulls = await tx.execute(
        sql`SELECT count(*)::int AS pending FROM automations WHERE triggers IS NULL`
      );
      if (nulls.rows[0]?.pending === 0) {
        await tx.execute(sql`ALTER TABLE automations ALTER COLUMN triggers SET NOT NULL`);
        notNull = true;
      }
    }

    return { seeded, cleared, stamped, runs, dropped: pending.dropLegacy, notNull };
  });

  if (!summary || !changedAnything(summary)) return;
  invalidateAutomationsCache();
  // The publish invalidates this instance's destination cache on the way out.
  await publishDestinationsChanged();
  logger.info(
    `Seeded ${summary.seeded} event automation(s), cleared ${summary.cleared} subscription(s), ` +
      `stamped ${summary.stamped} automation(s), backfilled ${summary.runs} run server(s)` +
      `${summary.dropped ? ', dropped the V1 columns' : ''}${summary.notNull ? ', triggers is NOT NULL' : ''}`
  );
}
