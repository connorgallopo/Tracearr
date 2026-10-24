/**
 * System-events boot migration integration tests
 *
 * Seeds the pre-phase-5 corpus — destinations subscribed to the five system events, pause and
 * inactivity rules whose thresholds still live in their conditions, a boolean transcode test,
 * a V1 row on a database that still has the dropped columns, and runs without a server — then
 * runs the migration against a real database: destination checkboxes become automations, the
 * thresholds land on their trigger nodes, the V1 columns go and `triggers` takes its NOT NULL.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- systemEventsMigration
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import type {
  Action,
  AutomationConditions,
  NotificationEventType,
  TriggerNode,
} from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import {
  automations,
  automationRuns,
  automationTemplates,
  automationVersions,
  destinations,
} from '../../src/db/schema.js';
import { runAutomationModelMigration } from '../../src/services/automations/modelMigration.js';
import { runSystemEventsMigration } from '../../src/services/automations/systemEventsMigration.js';
import { materializeInstance } from '../../src/services/automations/templates/materialize.js';
import { seedBuiltinTemplates } from '../../src/services/automations/templates/seeder.js';
import {
  getTemplate,
  instantiateTemplate,
} from '../../src/services/automations/templates/store.js';
import {
  runDestinationsMigration,
  seedBuiltinDestinations,
} from '../../src/services/notifications/destinationsMigration.js';

/**
 * The worker's database is shared by every file it runs, and this migration drops columns and
 * adds a constraint. Both are put back around each test so the next file sees what it expects.
 */
async function restoreLegacyShape(): Promise<void> {
  await db.execute(sql`ALTER TABLE automations ADD COLUMN IF NOT EXISTS type varchar(50)`);
  await db.execute(sql`ALTER TABLE automations ADD COLUMN IF NOT EXISTS params jsonb`);
  await db.execute(sql`ALTER TABLE automations ALTER COLUMN triggers DROP NOT NULL`);
}

beforeEach(async () => {
  // Nothing references destinations, so the shared truncate never reaches them.
  await db.delete(destinations);
  await restoreLegacyShape();
});

afterAll(restoreLegacyShape);

const conditions = (...tests: Array<[string, string, unknown]>): AutomationConditions =>
  ({
    groups: tests.map(([field, operator, value]) => ({
      conditions: [{ id: randomUUID(), enabled: true, field, operator, value }],
    })),
  }) as AutomationConditions;

async function insertDestination(values: {
  name: string;
  type: 'discord' | 'ntfy';
  events: NotificationEventType[];
  enabled?: boolean;
}): Promise<string> {
  const [row] = await db
    .insert(destinations)
    .values({
      name: values.name,
      type: values.type,
      config: null,
      events: values.events,
      enabled: values.enabled ?? true,
    })
    .returning({ id: destinations.id });
  if (!row) throw new Error(`failed to insert ${values.name}`);
  return row.id;
}

/** What a pre-phase-5 row can hold: a held_for or inactive_for node with no params at all. */
type StoredTrigger = { id: string; type: TriggerNode['type']; enabled: boolean; params?: unknown };

async function insertAutomation(values: {
  name: string;
  conditions: AutomationConditions;
  triggers: StoredTrigger[];
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(automations)
    .values({
      name: values.name,
      severity: 'warning',
      isActive: true,
      conditions: values.conditions,
      // The column is typed to the live union; these rows predate the params it requires.
      triggers: values.triggers as TriggerNode[],
      actions: { actions: [] },
    })
    .returning({ id: automations.id });
  if (!row) throw new Error(`failed to insert ${values.name}`);
  return row;
}

/** The V1 columns left the schema, so the row that still uses them goes in as raw SQL. */
async function insertV1(name: string): Promise<string> {
  const result = await db.execute(sql`
    INSERT INTO automations (name, type, params, severity, is_active, triggers)
    VALUES (${name}, 'concurrent_streams', '{"maxStreams": 2}'::jsonb, 'low', true, NULL)
    RETURNING id::text AS id
  `);
  const id = result.rows[0]?.id;
  if (typeof id !== 'string') throw new Error(`failed to insert ${name}`);
  return id;
}

const load = async (id: string) => {
  const [row] = await db.select().from(automations).where(eq(automations.id, id));
  if (!row) throw new Error(`automation ${id} vanished`);
  return row;
};

const xminOf = async (id: string): Promise<string> => {
  const result = await db.execute(
    sql`SELECT xmin::text AS version FROM automations WHERE id = ${id}`
  );
  return String(result.rows[0]?.version);
};

const versionCount = async (id: string): Promise<number> =>
  (await db.select().from(automationVersions).where(eq(automationVersions.automationId, id)))
    .length;

/** The instance the migration seeded from a builtin template, by slug. */
async function seededBySlug(slug: string) {
  const rows = await db
    .select({
      id: automations.id,
      name: automations.name,
      isActive: automations.isActive,
      serverId: automations.serverId,
      kind: automations.kind,
      triggers: automations.triggers,
      actions: automations.actions,
      templateVersion: automations.templateVersion,
      templateInputs: automations.templateInputs,
    })
    .from(automations)
    .innerJoin(automationTemplates, eq(automations.templateId, automationTemplates.id))
    .where(eq(automationTemplates.slug, slug));
  return rows[0] ?? null;
}

const sendTo = (row: { actions: { actions: Action[] } | null } | null): string[] => {
  const send = row?.actions?.actions.find((action) => action.type === 'send');
  return send?.type === 'send' ? [...send.to].sort() : [];
};

const legacyColumns = async (): Promise<string[]> => {
  const result = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'automations'
      AND column_name IN ('type', 'params')
  `);
  return result.rows.map((row) => String(row.column_name));
};

const triggersNullable = async (): Promise<boolean> => {
  const result = await db.execute(sql`
    SELECT NOT attnotnull AS nullable FROM pg_attribute
    WHERE attrelid = 'automations'::regclass AND attname = 'triggers'
  `);
  return result.rows[0]?.nullable === true;
};

const events = async (id: string): Promise<NotificationEventType[]> => {
  const [row] = await db
    .select({ events: destinations.events })
    .from(destinations)
    .where(eq(destinations.id, id));
  return row?.events ?? [];
};

/** A builtin template instance bound to a destination, the way the route binds it. */
async function bindPausedTooLong(destinationId: string): Promise<{ id: string }> {
  const [found] = await db
    .select({ id: automationTemplates.id })
    .from(automationTemplates)
    .where(eq(automationTemplates.slug, 'paused-too-long'));
  if (!found) throw new Error('paused-too-long is not seeded');
  const template = await getTemplate(found.id);
  if (!template) throw new Error('paused-too-long has no current version');

  const inputs = { minutes: 1, to: [destinationId] };
  const materialized = materializeInstance(template.version, inputs, template.name);
  if (!materialized.ok) throw new Error(materialized.reason);
  return db.transaction((tx) =>
    instantiateTemplate(tx, template, { definition: materialized.definition, inputs }, {})
  );
}

/**
 * The routing table a fresh install's migrations leave behind: browser toasts for streams,
 * every channel for the rest. Restated rather than assumed, since the destinations migration
 * retires the table on the first boot that reads it. 0004 seeds new_device on and
 * trust_score_changed off; 0018 then checks web_toast_enabled for every row it finds.
 */
async function seedRoutingTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS notification_channel_routing (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type varchar(50) NOT NULL UNIQUE,
      discord_enabled boolean NOT NULL DEFAULT true,
      webhook_enabled boolean NOT NULL DEFAULT true,
      push_enabled boolean NOT NULL DEFAULT true,
      web_toast_enabled boolean NOT NULL DEFAULT true
    )
  `);
  await db.execute(sql`
    INSERT INTO notification_channel_routing
      (event_type, discord_enabled, webhook_enabled, push_enabled, web_toast_enabled)
    VALUES ('violation_detected', true, true, true, true),
           ('server_down', true, true, true, true),
           ('server_up', true, true, true, true),
           ('stream_started', false, false, false, true),
           ('stream_stopped', false, false, false, true),
           ('new_device', true, true, true, true),
           ('trust_score_changed', false, false, false, true)
    ON CONFLICT (event_type) DO UPDATE SET
      discord_enabled = excluded.discord_enabled,
      webhook_enabled = excluded.webhook_enabled,
      push_enabled = excluded.push_enabled,
      web_toast_enabled = excluded.web_toast_enabled
  `);
}

async function seedCorpus() {
  const builtins = await seedBuiltinDestinations();
  await seedBuiltinTemplates();

  const discord = await insertDestination({
    name: 'Discord',
    type: 'discord',
    events: ['violation_detected', 'stream_started', 'server_down'],
  });
  const ntfy = await insertDestination({
    name: 'ntfy',
    type: 'ntfy',
    events: ['stream_stopped', 'plugin_update_available'],
  });
  const quiet = await insertDestination({
    name: 'Off duty',
    type: 'discord',
    events: ['server_up'],
    enabled: false,
  });

  const owner = await createTestUser({ role: 'owner' });
  const server = await createTestServer({ type: 'plex' });
  const serverUser = await createTestServerUser({ userId: owner.id, serverId: server.id });
  const session = await createTestSession({ serverId: server.id, serverUserId: serverUser.id });

  const heldForId = randomUUID();
  const pausedId = randomUUID();
  const pause = await insertAutomation({
    name: 'pause rule',
    conditions: conditions(
      ['current_pause_minutes', 'gte', 30],
      ['total_pause_minutes', 'gte', 120]
    ),
    triggers: [
      { id: randomUUID(), type: 'session.started', enabled: true },
      { id: pausedId, type: 'session.paused', enabled: true },
      // The node the threshold has to move onto: stamped before params existed.
      { id: heldForId, type: 'session.held_for', enabled: true },
    ],
  });
  const inactiveId = randomUUID();
  const inactive = await insertAutomation({
    name: 'inactive rule',
    conditions: conditions(['inactive_days', 'gte', 45]),
    triggers: [{ id: inactiveId, type: 'account.inactive_for', enabled: true }],
  });
  const lowId = randomUUID();
  const lowThreshold = await insertAutomation({
    name: 'one minute rule',
    conditions: conditions(['current_pause_minutes', 'gte', 1]),
    triggers: [{ id: lowId, type: 'session.held_for', enabled: true }],
  });
  // The regression this pass must not cause: an instance legitimately bound at one minute
  // carries no conditions to re-derive from.
  const bound = await bindPausedTooLong(discord);
  const transcodeStartedId = randomUUID();
  const transcode = await insertAutomation({
    name: 'transcode rule',
    conditions: conditions(['is_transcoding', 'eq', true]),
    triggers: [
      { id: transcodeStartedId, type: 'session.started', enabled: true },
      { id: randomUUID(), type: 'session.transcode_changed', enabled: true },
    ],
  });
  const v1 = await insertV1('v1 concurrent');

  const [sessionRun] = await db
    .insert(automationRuns)
    .values({
      automationId: transcode.id,
      serverUserId: serverUser.id,
      sessionId: session.id,
      severity: 'warning',
      data: {},
    })
    .returning({ id: automationRuns.id });
  const [accountRun] = await db
    .insert(automationRuns)
    .values({
      automationId: inactive.id,
      serverUserId: serverUser.id,
      sessionId: null,
      severity: 'warning',
      data: {},
    })
    .returning({ id: automationRuns.id });
  if (!sessionRun || !accountRun) throw new Error('failed to insert runs');

  return {
    builtins,
    destinations: { discord, ntfy, quiet },
    server,
    rules: { pause, inactive, lowThreshold, transcode, v1, bound },
    nodes: { heldForId, pausedId, inactiveId, lowId, transcodeStartedId },
    runs: { sessionRun: sessionRun.id, accountRun: accountRun.id },
  };
}

const runServerIds = async (ids: string[]): Promise<Array<string | null>> => {
  const rows = await Promise.all(
    ids.map(async (id) => {
      const [row] = await db
        .select({ serverId: automationRuns.serverId })
        .from(automationRuns)
        .where(eq(automationRuns.id, id));
      return row?.serverId ?? null;
    })
  );
  return rows;
};

const snapshot = async () => {
  const rows = await db.execute(sql`
    SELECT 'automation' AS kind, id::text AS id, xmin::text AS version FROM automations
    UNION ALL
    SELECT 'destination', id::text, xmin::text FROM destinations
    UNION ALL
    SELECT 'run', id::text, xmin::text FROM automation_runs
    ORDER BY 1, 2
  `);
  return rows.rows;
};

describe('runSystemEventsMigration', () => {
  it('turns subscriptions into automations, moves thresholds onto triggers and retires the V1 columns', async () => {
    const seeded = await seedCorpus();
    await runAutomationModelMigration();

    await runSystemEventsMigration();

    const streamStarted = await seededBySlug('stream-started');
    expect(streamStarted?.name).toBe('Stream started');
    expect(streamStarted?.isActive).toBe(true);
    expect(streamStarted?.serverId).toBeNull();
    expect(streamStarted?.templateVersion).toBe(1);
    expect(streamStarted?.templateInputs).toEqual({ to: [seeded.destinations.discord] });
    expect(sendTo(streamStarted)).toEqual([seeded.destinations.discord]);
    expect((streamStarted?.triggers ?? []).map((node) => node.type)).toEqual(['session.started']);

    expect(sendTo(await seededBySlug('stream-ended'))).toEqual([seeded.destinations.ntfy]);
    expect(sendTo(await seededBySlug('plugin-update'))).toEqual([seeded.destinations.ntfy]);
    expect(sendTo(await seededBySlug('server-down'))).toEqual(
      [seeded.destinations.discord, seeded.builtins.pushId, seeded.builtins.webToastId].sort()
    );
    // The disabled destination still counts: the subscription was the intent.
    expect(sendTo(await seededBySlug('server-up'))).toEqual(
      [seeded.destinations.quiet, seeded.builtins.pushId, seeded.builtins.webToastId].sort()
    );

    for (const id of [
      seeded.destinations.discord,
      seeded.destinations.ntfy,
      seeded.destinations.quiet,
      seeded.builtins.pushId,
      seeded.builtins.webToastId,
    ]) {
      expect((await events(id)).every((event) => event === 'violation_detected')).toBe(true);
    }
    expect(await events(seeded.destinations.discord)).toEqual(['violation_detected']);
    expect(await events(seeded.destinations.ntfy)).toEqual([]);

    const pause = await load(seeded.rules.pause.id);
    expect(pause.triggers).toEqual([
      { id: expect.any(String), type: 'session.started', enabled: true },
      { id: seeded.nodes.pausedId, type: 'session.paused', enabled: true },
      {
        id: seeded.nodes.heldForId,
        type: 'session.held_for',
        enabled: true,
        params: { minutes: 30, measure: 'current' },
      },
      {
        id: expect.any(String),
        type: 'session.held_for',
        enabled: true,
        params: { minutes: 120, measure: 'total' },
      },
    ]);

    const inactive = await load(seeded.rules.inactive.id);
    expect(inactive.triggers).toEqual([
      {
        id: seeded.nodes.inactiveId,
        type: 'account.inactive_for',
        enabled: true,
        params: { days: 45 },
      },
    ]);

    const low = await load(seeded.rules.lowThreshold.id);
    expect(low.triggers).toEqual([
      {
        id: seeded.nodes.lowId,
        type: 'session.held_for',
        enabled: true,
        params: { minutes: 1, measure: 'current' },
      },
    ]);

    const transcode = await load(seeded.rules.transcode.id);
    expect(transcode.conditions?.groups[0]?.conditions[0]?.value).toBe('video_or_audio');
    // Only its condition value was wrong, so its trigger nodes are left alone.
    expect((transcode.triggers ?? []).map((node) => node.id)).toEqual([
      seeded.nodes.transcodeStartedId,
      expect.any(String),
    ]);

    expect(await runServerIds([seeded.runs.sessionRun, seeded.runs.accountRun])).toEqual([
      seeded.server.id,
      seeded.server.id,
    ]);

    // One version per rewritten automation, and none for the row it left alone.
    expect(await versionCount(seeded.rules.pause.id)).toBe(2);
    expect(await versionCount(seeded.rules.inactive.id)).toBe(2);
    expect(await versionCount(seeded.rules.lowThreshold.id)).toBe(2);
    expect(await versionCount(seeded.rules.transcode.id)).toBe(2);
    expect(await versionCount(seeded.rules.bound.id)).toBe(1);

    expect(await legacyColumns()).toEqual([]);
    expect(await triggersNullable()).toBe(false);
  });

  it('leaves an instance bound at one minute exactly as it was', async () => {
    const seeded = await seedCorpus();
    await runAutomationModelMigration();
    const before = await load(seeded.rules.bound.id);
    const beforeXmin = await xminOf(seeded.rules.bound.id);

    await runSystemEventsMigration();

    const after = await load(seeded.rules.bound.id);
    expect(after.triggers).toEqual(before.triggers);
    expect(after.triggers?.[0]?.params).toEqual({ minutes: 1, measure: 'current' });
    expect(await xminOf(seeded.rules.bound.id)).toBe(beforeXmin);
    expect(await versionCount(seeded.rules.bound.id)).toBe(1);
  });

  it('writes nothing and logs nothing on a second pass', async () => {
    await seedCorpus();
    await runAutomationModelMigration();
    await runSystemEventsMigration();

    const before = await snapshot();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await runSystemEventsMigration();

    const lines = infoSpy.mock.calls.filter((call) =>
      String(call[0]).includes('[system-events-migration]')
    );
    infoSpy.mockRestore();

    expect(lines).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it('owes nothing for an install run and finds a session by its stored start', async () => {
    await runSystemEventsMigration();
    const owner = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const serverUser = await createTestServerUser({ userId: owner.id, serverId: server.id });
    const session = await createTestSession({ serverId: server.id, serverUserId: serverUser.id });
    const rule = await insertAutomation({
      name: 'update rule',
      conditions: conditions(),
      triggers: [],
    });
    await db.insert(automationRuns).values({ automationId: rule.id, data: {} });

    const transaction = vi.spyOn(db, 'transaction');
    await runSystemEventsMigration();
    expect(transaction).not.toHaveBeenCalled();

    // No account either, so only the session can name the server.
    const [run] = await db
      .insert(automationRuns)
      .values({
        automationId: rule.id,
        sessionId: session.id,
        sessionStartedAt: session.startedAt,
        data: {},
      })
      .returning({ id: automationRuns.id });
    if (!run) throw new Error('failed to insert run');
    await runSystemEventsMigration();
    expect(await runServerIds([run.id])).toEqual([server.id]);
  });

  it("carries a fresh install's own defaults across, browser stream toasts included", async () => {
    await seedRoutingTable();
    await seedBuiltinTemplates();

    // The real boot order: the destinations migration decides what the builtins subscribe to.
    await runDestinationsMigration();
    const builtins = await seedBuiltinDestinations();
    await runSystemEventsMigration();

    const both = [builtins.pushId, builtins.webToastId].sort();
    expect(sendTo(await seededBySlug('server-down'))).toEqual(both);
    expect(sendTo(await seededBySlug('server-up'))).toEqual(both);
    // Only the browser was subscribed to streams, so only it hears about them.
    expect(sendTo(await seededBySlug('stream-started'))).toEqual([builtins.webToastId]);
    expect(sendTo(await seededBySlug('stream-ended'))).toEqual([builtins.webToastId]);
    expect(await seededBySlug('plugin-update')).toBeNull();
    expect(await events(builtins.pushId)).toEqual(['violation_detected']);
    expect(await events(builtins.webToastId)).toEqual(['violation_detected']);
  });

  it('seeds new device on a fresh install and leaves trust score changed alone', async () => {
    await seedRoutingTable();
    await seedBuiltinTemplates();

    await runDestinationsMigration();
    const builtins = await seedBuiltinDestinations();
    await runSystemEventsMigration();

    const both = [builtins.pushId, builtins.webToastId].sort();
    expect(sendTo(await seededBySlug('new-device'))).toEqual(both);
    // 0018's toast column does not gate trust.
    expect(await seededBySlug('trust-score-changed')).toBeNull();

    const seeded = await db
      .select({ id: automations.id })
      .from(automations)
      .where(sql`template_id IS NOT NULL`);
    expect(seeded).toHaveLength(5);
  });

  it('converts a trust subscription the owner actually ticked', async () => {
    await seedRoutingTable();
    await seedBuiltinTemplates();
    // Push is a column an owner had to tick themselves, unlike the toast 0018 set for everyone.
    await db.execute(sql`
      UPDATE notification_channel_routing
      SET push_enabled = true WHERE event_type = 'trust_score_changed'
    `);

    await runDestinationsMigration();
    const builtins = await seedBuiltinDestinations();
    await runSystemEventsMigration();

    expect(sendTo(await seededBySlug('trust-score-changed'))).toEqual([builtins.pushId]);
  });

  it('finishes the steps a half-applied upgrade left behind without seeding twice', async () => {
    const seeded = await seedCorpus();
    await runAutomationModelMigration();

    // A first pass converts the subscriptions; what follows is what a killed upgrade leaves.
    await runSystemEventsMigration();
    const seededIds = (
      await db
        .select({ id: automations.id })
        .from(automations)
        .where(sql`template_id IS NOT NULL`)
    ).map((row) => row.id);
    await db
      .update(automations)
      .set({
        // A node the first pass never reached, back the way an older instance wrote it.
        triggers: [
          { id: seeded.nodes.inactiveId, type: 'account.inactive_for', enabled: true },
        ] as TriggerNode[],
      })
      .where(eq(automations.id, seeded.rules.inactive.id));
    await db.execute(sql`UPDATE automation_runs SET server_id = NULL`);

    await runSystemEventsMigration();

    const again = (
      await db
        .select({ id: automations.id })
        .from(automations)
        .where(sql`template_id IS NOT NULL`)
    ).map((row) => row.id);
    expect(again.sort()).toEqual(seededIds.sort());
    expect((await load(seeded.rules.inactive.id)).triggers?.[0]?.params).toEqual({ days: 45 });
    expect(await runServerIds([seeded.runs.sessionRun])).toEqual([seeded.server.id]);
  });

  it('keeps the V1 columns while a row still needs them', async () => {
    await seedCorpus();

    await runSystemEventsMigration();

    expect((await legacyColumns()).sort()).toEqual(['params', 'type']);
    expect(await triggersNullable()).toBe(true);
  });
});
