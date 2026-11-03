import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  EngineAutomation,
  PushDeliveryStatus,
  PushEventPreference,
  PushSwitch,
  TriggerType,
} from '@tracearr/shared';
import { db, type Executor } from '../db/client.js';
import {
  automations,
  automationTemplates,
  destinations,
  notificationPreferences,
} from '../db/schema.js';
import { getActiveAutomations, invalidateAutomationsCache } from '../jobs/poller/database.js';
import { createLogger } from '../utils/logger.js';
import { materializeInstance } from './automations/templates/materialize.js';
import {
  getTemplate,
  getTemplateVersion,
  instantiateTemplate,
} from './automations/templates/store.js';
import { carryTriggerIds } from './automations/triggers.js';
import {
  automationDefinition,
  insertAutomationVersion,
  sameDefinition,
  type AutomationRow,
} from './automations/versions.js';
import { leaves } from './notifications/destinationRefs.js';
import { listDestinations, publishDestinationsChanged } from './notifications/destinationStore.js';

const logger = createLogger('push-switches');

/** Distinct from the boot migrations' 875_100_003 to 875_100_006. */
const LOCK_KEY = 875_100_007;

/**
 * The switch each trigger's push answers to; null where no switch does. Follows
 * nativeEventFor in the executors: a trigger with no event of its own sends the
 * violation shape.
 */
const TRIGGER_PREFERENCE = {
  'session.started': 'onStreamStarted',
  'session.first_seen': 'onStreamStarted',
  'session.stopped': 'onStreamStopped',
  'session.transcode_changed': 'onViolationDetected',
  'session.paused': 'onViolationDetected',
  'session.held_for': 'onViolationDetected',
  'account.inactive_for': 'onViolationDetected',
  'account.new_device': 'onNewDevice',
  'account.trust_changed': 'onTrustScoreChanged',
  'account.media_downloaded': 'onViolationDetected',
  'media.added': null,
  'media.upgraded': null,
  'server.down': 'onServerDown',
  'server.up': 'onServerUp',
  'plugin.update_available': null,
  'server.update_available': null,
  'tracearr.update_available': null,
  'newsletter.sent': null,
  'newsletter.failed': null,
} as const satisfies Record<TriggerType, PushEventPreference | null>;

type EventPreference = Exclude<PushEventPreference, 'onViolationDetected'>;

/** The builtin template a switch creates and edits; every other sender is the web's to change. */
const SWITCH_TEMPLATE = {
  onStreamStarted: 'stream-started',
  onStreamStopped: 'stream-ended',
  onNewDevice: 'new-device',
  onTrustScoreChanged: 'trust-score-changed',
  onServerDown: 'server-down',
  onServerUp: 'server-up',
} as const satisfies Record<EventPreference, string>;

const EVENT_PREFERENCES = Object.keys(SWITCH_TEMPLATE) as EventPreference[];
export const PUSH_PREFERENCES: readonly PushEventPreference[] = [
  'onViolationDetected',
  ...EVENT_PREFERENCES,
];

const byPreference = <T>(value: (key: PushEventPreference) => T) =>
  Object.fromEntries(PUSH_PREFERENCES.map((key) => [key, value(key)])) as Record<
    PushEventPreference,
    T
  >;

const sendsTo = (automation: Pick<EngineAutomation, 'actions'>, destinationId: string): boolean =>
  automation.actions.actions
    .filter((action) => action.enabled !== false)
    .flatMap(leaves)
    .some(
      (action) =>
        action.type === 'send' && action.enabled !== false && action.to.includes(destinationId)
    );

/** The automations that send each event to the destination. */
function pushSenders<T extends Pick<EngineAutomation, 'kind' | 'triggers' | 'actions'>>(
  automations: readonly T[],
  destinationId: string
): Record<PushEventPreference, T[]> {
  const senders = byPreference((): T[] => []);
  for (const automation of automations) {
    const triggers = automation.triggers.filter((trigger) => trigger.enabled);
    if (triggers.length === 0 || !sendsTo(automation, destinationId)) continue;
    // Only a notification automation sends its trigger's own event.
    const preferences =
      automation.kind === 'notification'
        ? triggers.map((trigger) => TRIGGER_PREFERENCE[trigger.type])
        : (['onViolationDetected'] as const);
    for (const preference of new Set(preferences)) {
      if (preference) senders[preference].push(automation);
    }
  }
  return senders;
}

/** How many of the automations send each event to the destination, one count per automation. */
export function pushSenderCounts(
  automations: readonly Pick<EngineAutomation, 'kind' | 'triggers' | 'actions'>[],
  destinationId: string
): Record<PushEventPreference, number> {
  const senders = pushSenders(automations, destinationId);
  return byPreference((key) => senders[key].length);
}

const boundTo = (row: Pick<AutomationRow, 'templateInputs'>): string[] => {
  const to = row.templateInputs?.to;
  return Array.isArray(to) ? to.filter((id): id is string => typeof id === 'string') : [];
};

/** The unscoped instances of the switches' builtin templates, oldest first: what a switch owns. */
async function ownedInstances(executor: Executor, preferences: readonly EventPreference[]) {
  const rows = await executor
    .select({ automation: automations, slug: automationTemplates.slug })
    .from(automations)
    .innerJoin(automationTemplates, eq(automationTemplates.id, automations.templateId))
    .where(
      and(
        inArray(
          automationTemplates.slug,
          preferences.map((key) => SWITCH_TEMPLATE[key])
        ),
        eq(automationTemplates.builtin, true),
        isNull(automations.serverId)
      )
    )
    .orderBy(asc(automations.createdAt), asc(automations.id));
  return rows;
}

const setActive = (tx: Executor, id: string, isActive: boolean) =>
  tx.update(automations).set({ isActive, updatedAt: new Date() }).where(eq(automations.id, id));

/** A template rebind, the same write PATCH /automations/:id makes for `templateInputs`. */
async function rebind(tx: Executor, row: AutomationRow, to: string[], isActive: boolean) {
  const pinned =
    row.templateId && row.templateVersion !== null
      ? await getTemplateVersion(row.templateId, row.templateVersion)
      : null;
  if (!pinned) throw new Error(`automation ${row.id}: its template version is gone`);
  const inputs = { ...row.templateInputs, to };
  const materialized = materializeInstance(pinned, inputs, row.name);
  if (!materialized.ok) throw new Error(`automation ${row.id}: ${materialized.reason}`);

  const [updated] = await tx
    .update(automations)
    .set({
      conditions: materialized.definition.conditions,
      actions: materialized.definition.actions,
      triggers: carryTriggerIds(materialized.definition.triggers, row.triggers),
      templateInputs: inputs,
      isActive,
      updatedAt: new Date(),
    })
    .where(eq(automations.id, row.id))
    .returning();
  if (!updated) throw new Error(`automation ${row.id} vanished mid-write`);
  const definition = automationDefinition(updated);
  if (!sameDefinition(definition, automationDefinition(row))) {
    await insertAutomationVersion(tx, row.id, definition);
  }
}

async function setEventSwitch(
  tx: Executor,
  preference: EventPreference,
  on: boolean,
  pushId: string
): Promise<void> {
  const owned = (await ownedInstances(tx, [preference])).map((row) => row.automation);

  if (!on) {
    for (const row of owned) {
      const to = boundTo(row);
      if (!row.isActive || !to.includes(pushId)) continue;
      const rest = to.filter((id) => id !== pushId);
      // `to` needs one destination, so a push-only instance is paused instead.
      if (rest.length === 0) await setActive(tx, row.id, false);
      else await rebind(tx, row, rest, true);
    }
    return;
  }

  const withPush = owned.find((row) => boundTo(row).includes(pushId));
  if (withPush) {
    if (!withPush.isActive) await setActive(tx, withPush.id, true);
    return;
  }
  // A paused instance that never named push was paused in the web for its other destinations,
  // so it stays paused and push gets an instance of its own.
  const active = owned.find((row) => row.isActive);
  if (active) {
    await rebind(tx, active, [...boundTo(active), pushId], true);
    return;
  }

  const slug = SWITCH_TEMPLATE[preference];
  const [found] = await tx
    .select({ id: automationTemplates.id })
    .from(automationTemplates)
    .where(and(eq(automationTemplates.slug, slug), eq(automationTemplates.builtin, true)));
  const template = found ? await getTemplate(found.id, tx) : null;
  if (!template) throw new Error(`builtin template ${slug} is missing`);
  const inputs = { to: [pushId] };
  const materialized = materializeInstance(template.version, inputs, template.name);
  if (!materialized.ok) throw new Error(`${slug}: ${materialized.reason}`);
  await instantiateTemplate(tx, template, { definition: materialized.definition, inputs }, {});
}

type SwitchChange = Partial<Record<PushEventPreference, boolean>>;

/** Inside a transaction holding LOCK_KEY. Returns whether Mobile push's subscriptions moved. */
async function applySwitches(tx: Executor, change: SwitchChange): Promise<boolean> {
  const [push] = await tx.select().from(destinations).where(eq(destinations.type, 'push'));
  // A disabled destination reads every switch off, so a flip there changes nothing.
  if (!push?.enabled) return false;

  for (const preference of EVENT_PREFERENCES) {
    const on = change[preference];
    if (on !== undefined) await setEventSwitch(tx, preference, on, push.id);
  }

  const violations = change.onViolationDetected;
  if (violations === undefined || push.events.includes('violation_detected') === violations) {
    return false;
  }
  await tx
    .update(destinations)
    .set({
      events: violations
        ? [...push.events, 'violation_detected']
        : push.events.filter((event) => event !== 'violation_detected'),
      updatedAt: new Date(),
    })
    .where(eq(destinations.id, push.id));
  return true;
}

async function writeSwitches(run: (tx: Executor) => Promise<boolean>): Promise<void> {
  const subscriptionsMoved = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
    return run(tx);
  });
  invalidateAutomationsCache();
  if (subscriptionsMoved) await publishDestinationsChanged();
}

/**
 * A phone's switch writes the server-wide senders: the violation subscription on Mobile push,
 * or the builtin template instance for the event. Senders built in the web are left alone.
 */
export async function setPushSwitches(change: SwitchChange): Promise<void> {
  if (Object.keys(change).length === 0) return;
  await writeSwitches((tx) => applySwitches(tx, change));
}

const PREFERENCE_COLUMNS = {
  onViolationDetected: notificationPreferences.onViolationDetected,
  onStreamStarted: notificationPreferences.onStreamStarted,
  onStreamStopped: notificationPreferences.onStreamStopped,
  onNewDevice: notificationPreferences.onNewDevice,
  onTrustScoreChanged: notificationPreferences.onTrustScoreChanged,
  onServerDown: notificationPreferences.onServerDown,
  onServerUp: notificationPreferences.onServerUp,
} as const satisfies Record<PushEventPreference, unknown>;

/**
 * The switches used to be per-device filters. An event every device had off is switched off
 * at its senders; a mute only some devices held is dropped and logged. The columns are then
 * reset, which is what makes every later boot a no-op.
 */
export async function reconcileDeviceMutes(): Promise<void> {
  await writeSwitches(async (tx) => {
    const rows = await tx
      .select({ mobileSessionId: notificationPreferences.mobileSessionId, ...PREFERENCE_COLUMNS })
      .from(notificationPreferences);
    if (rows.every((row) => PUSH_PREFERENCES.every((key) => row[key]))) return false;

    const change: SwitchChange = {};
    for (const key of PUSH_PREFERENCES) {
      const muted = rows.filter((row) => !row[key]);
      if (muted.length === rows.length) change[key] = false;
      else if (muted.length > 0) {
        logger.info(`${key} was off on some devices only; the switch is shared now`, {
          muted: muted.map((row) => row.mobileSessionId),
          devices: rows.length,
        });
      }
    }
    logger.info('device mutes moved to the senders', { switchedOff: Object.keys(change) });

    const subscriptionsMoved = await applySwitches(tx, change);
    await tx.update(notificationPreferences).set(byPreference(() => true));
    return subscriptionsMoved;
  });
}

export async function getPushDelivery(): Promise<Omit<PushDeliveryStatus, 'tokenRegistered'>> {
  const push = (await listDestinations()).find((d) => d.type === 'push');
  const senders = pushSenders(push ? await getActiveAutomations() : [], push?.id ?? '');
  const enabled = push?.enabled ?? false;
  const subscribed = push?.events.includes('violation_detected') ?? false;
  const owned = new Set(
    (await ownedInstances(db, EVENT_PREFERENCES)).map((row) => row.automation.id)
  );

  return {
    destinationEnabled: enabled,
    violationsSubscribed: subscribed,
    automations: byPreference((key) => senders[key].length),
    switches: byPreference((key): PushSwitch => {
      const list = senders[key];
      // The violation switch is the subscription, so every automation sender is someone else's.
      const others =
        key === 'onViolationDetected' ? list : list.filter((row) => !owned.has(row.id));
      return {
        on: enabled && (key === 'onViolationDetected' ? subscribed : list.length > 0),
        others: others.length,
        scoped: others.filter((row) => row.serverId !== null).length,
      };
    }),
  };
}
