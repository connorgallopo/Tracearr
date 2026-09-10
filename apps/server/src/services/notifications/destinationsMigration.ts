import { eq, inArray, sql } from 'drizzle-orm';
import {
  DESTINATION_TYPES,
  NOTIFICATION_EVENT_TYPES,
  type Action,
  type DestinationKind,
  type NotificationEventType,
  type AutomationActions,
} from '@tracearr/shared';
import { db, type Executor } from '../../db/client.js';
import { destinations, automations, settings } from '../../db/schema.js';
import { invalidateAutomationsCache } from '../../jobs/poller/database.js';
import { createLogger } from '../../utils/logger.js';
import { resetSettingsCache } from '../settings.js';
import { encryptConfig } from './destinationCrypto.js';
import {
  invalidateDestinationsCache,
  listDestinations,
  markReencrypt,
  publishDestinationsChanged,
  readConfig,
  rewrapConfig,
} from './destinationStore.js';

const logger = createLogger('destinations-migration');

export const SEVEN_KEYS = [
  'discordWebhookUrl',
  'customWebhookUrl',
  'webhookFormat',
  'ntfyTopic',
  'ntfyAuthToken',
  'pushoverUserKey',
  'pushoverApiToken',
] as const;
export type SevenKey = (typeof SEVEN_KEYS)[number];

/** Distinct from the schema runner's 875_100_002 and timescale's backfill 875_100_001. */
const LOCK_KEY = 875_100_003;

type WebhookKind = 'json_webhook' | 'ntfy' | 'gotify' | 'apprise';
const WEBHOOK_NAMES: Record<WebhookKind, string> = {
  json_webhook: 'Webhook',
  ntfy: 'ntfy',
  gotify: 'Gotify',
  apprise: 'Apprise',
};

export interface RoutingRow {
  eventType: string;
  discordEnabled: boolean;
  webhookEnabled: boolean;
  pushEnabled: boolean;
  webToastEnabled: boolean;
}

/** Rules written before the cutover hold `notify`, which the shared Action union does not include. */
interface LegacyNotifyAction {
  type: 'notify';
  channels: string[];
  cooldown_minutes?: number;
}

export interface PlanInput {
  settings: Record<SevenKey, string | null>;
  routing: RoutingRow[] | null;
  rules: Array<{
    id: string;
    name: string;
    isActive: boolean;
    actions: { actions: Array<Action | LegacyNotifyAction> } | null;
  }>;
  builtins: { pushId: string; webToastId: string };
}

export interface PlannedDestination {
  key: 'discord' | 'webhook' | 'pushover';
  type: DestinationKind;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  events: NotificationEventType[];
}

export interface Plan {
  destinations: PlannedDestination[];
  builtinEvents: { push: NotificationEventType[]; webToast: NotificationEventType[] };
  ruleUpdates: Array<{ id: string; actions: AutomationActions }>;
  logs: string[];
}

const set = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** The fallback getChannelRouting applied when no row existed for an event. */
function routingFor(routing: RoutingRow[] | null, event: NotificationEventType): RoutingRow {
  const row = routing?.find((r) => r.eventType === event);
  if (row) return row;
  // Trust joins the stream pair: 0004 seeded it off for everyone, so a database with no
  // routing table at all is no evidence anyone asked for it.
  const on = !(
    event === 'stream_started' ||
    event === 'stream_stopped' ||
    event === 'trust_score_changed'
  );
  return {
    eventType: event,
    discordEnabled: on,
    webhookEnabled: on,
    pushEnabled: on,
    webToastEnabled: on,
  };
}

const capable = (kind: DestinationKind, events: NotificationEventType[]): NotificationEventType[] =>
  events.filter((e) => (DESTINATION_TYPES[kind].events as readonly string[]).includes(e));

/** The events the pre-automation routing table knew; the update, media and newsletter events post-date it. */
const ROUTED_EVENTS: NotificationEventType[] = NOTIFICATION_EVENT_TYPES.filter(
  (e) =>
    e !== 'server_update_available' &&
    e !== 'tracearr_update_available' &&
    e !== 'media_added' &&
    e !== 'media_upgraded' &&
    e !== 'newsletter_send'
);

export function planDestinationsMigration(input: PlanInput): Plan {
  const s = input.settings;
  const logs: string[] = [];
  const planned: PlannedDestination[] = [];
  const evts = (pick: (r: RoutingRow) => boolean): NotificationEventType[] =>
    ROUTED_EVENTS.filter((e) => pick(routingFor(input.routing, e)));

  if (set(s.discordWebhookUrl)) {
    planned.push({
      key: 'discord',
      type: 'discord',
      name: 'Discord',
      config: { webhookUrl: s.discordWebhookUrl },
      enabled: true,
      events: capable(
        'discord',
        evts((r) => r.discordEnabled)
      ),
    });
  }

  const fmt = s.webhookFormat;
  if (set(s.customWebhookUrl)) {
    if (fmt === 'pushover') {
      logs.push('customWebhookUrl set with webhookFormat=pushover: no agent read it; not migrated');
    } else {
      const kind: WebhookKind =
        fmt === 'ntfy'
          ? 'ntfy'
          : fmt === 'gotify'
            ? 'gotify'
            : fmt === 'apprise'
              ? 'apprise'
              : 'json_webhook';
      const config: Record<string, unknown> = { url: s.customWebhookUrl };
      if (kind === 'ntfy') {
        config.topic = set(s.ntfyTopic) ? s.ntfyTopic : 'tracearr';
        if (set(s.ntfyAuthToken)) config.authToken = s.ntfyAuthToken;
      }
      planned.push({
        key: 'webhook',
        type: kind,
        name: WEBHOOK_NAMES[kind],
        config,
        enabled: true,
        events: capable(
          kind,
          evts((r) => r.webhookEnabled)
        ),
      });
    }
  }

  if (set(s.pushoverUserKey) && set(s.pushoverApiToken)) {
    planned.push({
      key: 'pushover',
      type: 'pushover',
      name: 'Pushover',
      config: { userKey: s.pushoverUserKey, apiToken: s.pushoverApiToken },
      enabled: fmt === 'pushover',
      events: capable(
        'pushover',
        evts((r) => r.webhookEnabled)
      ),
    });
  }

  const ruleUpdates: Plan['ruleUpdates'] = [];
  const webhookRows = planned.filter((p) => p.key === 'webhook' || p.key === 'pushover');
  const discordRow = planned.find((p) => p.key === 'discord');
  for (const rule of input.rules) {
    const actions = rule.actions?.actions ?? [];
    if (!actions.some((a) => a.type === 'notify')) continue;
    const next: Action[] = [];
    for (const a of actions) {
      if (a.type !== 'notify') {
        next.push(a);
        continue;
      }
      const to = new Set<string>();
      for (const channel of a.channels) {
        // email never had an implementation, so it maps to nothing
        if (channel === 'push') to.add(input.builtins.pushId);
        else if (channel === 'discord' && discordRow) to.add(`planned:${discordRow.key}`);
        else if (channel === 'webhook') for (const w of webhookRows) to.add(`planned:${w.key}`);
      }
      if (to.size === 0) {
        logs.push(`rule "${rule.name}": notify action had no reachable destination; removed`);
        continue;
      }
      next.push({
        type: 'send',
        to: [...to],
        ...(a.cooldown_minutes !== undefined ? { cooldown_minutes: a.cooldown_minutes } : {}),
      });
    }
    ruleUpdates.push({ id: rule.id, actions: { actions: next } });
  }

  return {
    destinations: planned,
    builtinEvents: {
      push: capable(
        'push',
        evts((r) => r.pushEnabled)
      ),
      // 0018 set web_toast_enabled true on every existing row, so a checked toast is not
      // evidence anyone wanted trust-score alerts; its other three columns all default off.
      webToast: capable(
        'web_toast',
        evts((r) => r.webToastEnabled && r.eventType !== 'trust_score_changed')
      ),
    },
    ruleUpdates,
    logs,
  };
}

/** name.unique means a collision throws inside the transaction and boot retries forever, so count up until one is free. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  let candidate = `${name} (migrated)`;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${name} (migrated ${n})`;
  return candidate;
}

function mapRoutingRow(row: Record<string, unknown>): RoutingRow {
  return {
    eventType: typeof row.event_type === 'string' ? row.event_type : '',
    discordEnabled: row.discord_enabled === true,
    webhookEnabled: row.webhook_enabled === true,
    pushEnabled: row.push_enabled === true,
    webToastEnabled: row.web_toast_enabled === true,
  };
}

/**
 * Seeded events (everything but stream start/stop) only stick when no routing table exists, e.g.
 * after a factory reset; upgrades and fresh installs inherit the routing rows' toggles instead.
 * A bare ON CONFLICT DO NOTHING covers both unique indexes, so re-runs never touch existing rows.
 */
export async function seedBuiltinDestinations(
  executor: Executor = db
): Promise<{ pushId: string; webToastId: string; inserted: number }> {
  const defaultEvents = (kind: 'push' | 'web_toast'): NotificationEventType[] =>
    capable(kind, ROUTED_EVENTS).filter((e) => e !== 'stream_started' && e !== 'stream_stopped');
  const created = await executor
    .insert(destinations)
    .values([
      {
        name: 'Mobile push',
        type: 'push',
        config: null,
        events: defaultEvents('push'),
        enabled: true,
        builtin: true,
      },
      {
        name: 'Browser toasts',
        type: 'web_toast',
        config: null,
        events: defaultEvents('web_toast'),
        enabled: true,
        builtin: true,
      },
    ])
    .onConflictDoNothing()
    .returning({ id: destinations.id });
  const rows = await executor
    .select({ id: destinations.id, type: destinations.type })
    .from(destinations)
    .where(eq(destinations.builtin, true));
  const pushId = rows.find((r) => r.type === 'push')?.id;
  const webToastId = rows.find((r) => r.type === 'web_toast')?.id;
  if (pushId === undefined || webToastId === undefined) {
    throw new Error('built-in destinations are missing after seeding');
  }
  return { pushId, webToastId, inserted: created.length };
}

/** One transaction under an advisory lock; throws into boot recovery on failure. Re-runs are no-ops. */
export async function runDestinationsMigration(): Promise<void> {
  const changed = await db.transaction(async (tx): Promise<boolean> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
    const builtins = await seedBuiltinDestinations(tx);

    const settingRows = await tx
      .select({ name: settings.name, value: settings.value })
      .from(settings)
      .where(inArray(settings.name, [...SEVEN_KEYS]));
    const seven = Object.fromEntries(SEVEN_KEYS.map((k) => [k, null])) as Record<
      SevenKey,
      string | null
    >;
    for (const row of settingRows) {
      if (typeof row.value === 'string' && (SEVEN_KEYS as readonly string[]).includes(row.name)) {
        seven[row.name as SevenKey] = row.value;
      }
    }

    const ruleRows = await tx
      .select({
        id: automations.id,
        name: automations.name,
        isActive: automations.isActive,
        actions: automations.actions,
      })
      .from(automations);

    const regclass = await tx.execute(
      sql`SELECT to_regclass('public.notification_channel_routing') AS r`
    );
    const routingExists = regclass.rows[0]?.r != null;
    let routing: RoutingRow[] | null = null;
    if (routingExists) {
      const raw = await tx.execute(
        sql`SELECT event_type, discord_enabled, webhook_enabled, push_enabled, web_toast_enabled FROM notification_channel_routing`
      );
      routing = raw.rows.map(mapRoutingRow);
    }

    const plan = planDestinationsMigration({
      settings: seven,
      routing,
      rules: ruleRows,
      builtins,
    });
    if (
      plan.destinations.length === 0 &&
      plan.ruleUpdates.length === 0 &&
      settingRows.length === 0 &&
      !routingExists
    ) {
      return builtins.inserted > 0;
    }
    if (!routingExists) {
      logger.warn('notification_channel_routing absent; applying the fallback for every event');
    }
    for (const line of plan.logs) logger.warn(line);

    const ids = new Map<string, string>();
    // A user-made row could already own a planned name (settings re-entered after a downgrade); suffix instead of wedging boot.
    const taken = new Set(
      (await tx.select({ name: destinations.name }).from(destinations)).map((r) => r.name)
    );
    for (const p of plan.destinations) {
      const name = freeName(p.name, taken);
      taken.add(name);
      const [row] = await tx
        .insert(destinations)
        .values({
          name,
          type: p.type,
          config: encryptConfig(p.config),
          events: p.events,
          enabled: p.enabled,
        })
        .returning({ id: destinations.id });
      if (!row) throw new Error(`insert failed for ${p.name}`);
      ids.set(`planned:${p.key}`, row.id);
    }

    const now = new Date();
    await tx
      .update(destinations)
      .set({ events: plan.builtinEvents.push, updatedAt: now })
      .where(eq(destinations.id, builtins.pushId));
    await tx
      .update(destinations)
      .set({ events: plan.builtinEvents.webToast, updatedAt: now })
      .where(eq(destinations.id, builtins.webToastId));

    for (const update of plan.ruleUpdates) {
      const actions = update.actions.actions.map((a) =>
        a.type === 'send' ? { ...a, to: a.to.map((t) => ids.get(t) ?? t) } : a
      );
      await tx
        .update(automations)
        .set({ actions: { actions }, updatedAt: new Date() })
        .where(eq(automations.id, update.id));
    }

    await tx.delete(settings).where(inArray(settings.name, [...SEVEN_KEYS]));
    await tx.execute(sql`DROP TABLE IF EXISTS notification_channel_routing`);
    logger.info(
      `Migrated ${plan.destinations.length} destination(s) and ${plan.ruleUpdates.length} rule(s)`
    );
    return true;
  });
  invalidateAutomationsCache();
  invalidateDestinationsCache();
  resetSettingsCache();
  if (changed) await publishDestinationsChanged();
}

/** Decrypt every non-builtin row once at boot so a rotated key is reported per row instead of discovered job by job. */
export async function sweepDestinationConfigs(): Promise<void> {
  for (const row of await listDestinations()) {
    if (row.builtin || row.configStatus !== 'ok') continue;
    const opened = readConfig(row);
    if (opened.ok) {
      if (opened.rewrap) await rewrapConfig(row.id, opened.config);
      continue;
    }
    if (opened.reason === 'bad_key') {
      logger.warn(
        `destination "${row.name}" was encrypted under another key; marking for re-entry`
      );
      await markReencrypt(row.id);
    } else {
      logger.warn(`destination "${row.name}" has a malformed config blob; re-save it`);
    }
  }
}
