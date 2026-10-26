import {
  TIME_MS,
  WS_EVENTS,
  type EngineAutomation,
  type ServerDownReason,
  type Session,
} from '@tracearr/shared';
import { getActiveAutomations } from '../../../jobs/poller/database.js';
import { automationsLogger } from '../../../utils/logger.js';
import { getPubSubService } from '../../cache.js';
import { countDownloads } from '../../downloads/queries.js';
import { isLiveServer } from '../../liveServers.js';
import {
  assembleEvaluationInputs,
  installInputs,
  loadEvaluationContext,
  loadServerContext,
  serverContextFor,
} from './contextAssembly.js';
import { dispatch } from './dispatcher.js';
import { matchesTrigger } from './evaluate.js';
import type {
  AccountNewDeviceEvent,
  EvaluationInputs,
  EvaluationServer,
  EvaluationServerUser,
  SessionStopReason,
  TriggerType,
} from './types.js';
import type { MediaQuality, MediaSubject } from '../types.js';
import type { TrustMove } from '../../userService.js';
import type { NewsletterSendPayload } from '../../notifications/events.js';

/** The active automations when one of them listens for the trigger, else null: no listener, no context read. */
async function listeningRules(trigger: TriggerType): Promise<EngineAutomation[] | null> {
  const rules = await getActiveAutomations();
  return rules.some((rule) => matchesTrigger(rule, trigger)) ? rules : null;
}

/**
 * The same, narrowed to what a user-less event on this server can run: an automation
 * scoped to another server, to an account or to a person never applies to it.
 */
async function serverListeningRules(
  trigger: TriggerType,
  serverId: string
): Promise<EngineAutomation[] | null> {
  const rules = await getActiveAutomations();
  const scoped = rules.filter(
    (rule) =>
      matchesTrigger(rule, trigger) &&
      !rule.serverUserId &&
      !rule.userId &&
      (!rule.serverId || rule.serverId === serverId)
  );
  return scoped.length > 0 ? scoped : null;
}

/** Which media triggers anything on this server listens for, before the sync pays for a diff. */
export async function mediaListeners(
  serverId: string
): Promise<{ added: boolean; upgraded: boolean }> {
  const [added, upgraded] = await Promise.all([
    serverListeningRules('media.added', serverId),
    serverListeningRules('media.upgraded', serverId),
  ]);
  return { added: added !== null, upgraded: upgraded !== null };
}

/** Producers run after the write they announce, so a failed read must not unwind the caller. */
async function guarded(trigger: TriggerType, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    automationsLogger.error('Trigger dispatch failed', { trigger, error });
  }
}

/**
 * Every stop cancels its pause wake through the ref event; only a listening automation
 * pays for the account context, and only a stop that ended the stream evaluates at all.
 */
export async function dispatchSessionStopped(
  session: Session,
  durationMs: number,
  at: Date,
  reason: SessionStopReason = 'ended'
): Promise<void> {
  await guarded('session.stopped', async () => {
    await dispatch({
      type: 'session.ended',
      at,
      sessionId: session.id,
      serverId: session.serverId,
    });
    if (reason !== 'ended') return;
    const rules = await listeningRules('session.stopped');
    if (!rules) return;
    const context = await loadEvaluationContext(session.serverId, session.serverUserId, rules);
    if (!context) return;
    await dispatch(
      {
        type: 'session.stopped',
        at,
        server: context.server,
        serverUser: context.serverUser,
        session,
        durationMs,
      },
      context.inputs
    );
  });
}

/**
 * First sight of a new playback: the session exists only as a pending cache entry, so
 * listeners fire ahead of the confirmation delay. The id it carries is the one the
 * confirmed row will keep; a phantom that never confirms leaves its runs behind.
 */
export async function dispatchSessionFirstSeen(args: {
  session: Session;
  server: EvaluationServer;
  serverUser: EvaluationServerUser;
  at: Date;
}): Promise<void> {
  await guarded('session.first_seen', async () => {
    const rules = await listeningRules('session.first_seen');
    if (!rules) return;
    const inputs = await assembleEvaluationInputs({
      rules,
      server: args.server,
      serverUser: args.serverUser,
    });
    await dispatch(
      {
        type: 'session.first_seen',
        at: args.at,
        server: args.server,
        serverUser: args.serverUser,
        session: args.session,
      },
      inputs
    );
  });
}

/**
 * The poller probed for the device inside the insert transaction, so this runs on the
 * inputs session.started already evaluated in rather than assembling a second set.
 */
export async function dispatchNewDevice(
  event: Omit<AccountNewDeviceEvent, 'type'>,
  inputs: EvaluationInputs
): Promise<void> {
  await guarded('account.new_device', async () => {
    await dispatch({ type: 'account.new_device', ...event }, inputs);
  });
}

/**
 * Every trust writer announces through here, after its commit. A write that landed on the
 * value already stored is not a change, which is what most clamps and resets are.
 */
export async function dispatchTrustChanged(args: {
  serverId: string;
  serverUserId: string;
  previous: number;
  next: number;
  reason: string | null;
}): Promise<void> {
  if (args.previous === args.next) return;
  await guarded('account.trust_changed', async () => {
    const rules = await listeningRules('account.trust_changed');
    if (!rules) return;
    // A fresh read, so the evaluation context carries the score the write just left behind.
    const context = await loadEvaluationContext(args.serverId, args.serverUserId, rules);
    if (!context) return;
    await dispatch(
      {
        type: 'account.trust_changed',
        at: new Date(),
        server: context.server,
        serverUser: context.serverUser,
        session: null,
        previous: args.previous,
        next: args.next,
        reason: args.reason,
      },
      context.inputs
    );
  });
}

/** Older rows are the first poll's 24 h seed or a catch-up after downtime: stored, never announced. */
export const DISPATCH_FRESHNESS_MS = 10 * 60 * 1000;

/** The recorder announces each row it opened; collapsed repeats of the same item never reach here. */
export async function dispatchMediaDownloaded(args: {
  serverId: string;
  serverUserId: string;
  title: string;
  app: string | null;
  device: string | null;
  firstSeenAt: Date;
}): Promise<void> {
  if (Date.now() - args.firstSeenAt.getTime() > DISPATCH_FRESHNESS_MS) return;
  await guarded('account.media_downloaded', async () => {
    const rules = await listeningRules('account.media_downloaded');
    if (!rules) return;
    const context = await loadEvaluationContext(args.serverId, args.serverUserId, rules);
    if (!context) return;
    const identity = context.serverUser.identityServerUserIds;
    const ids = identity.length > 0 ? identity : [args.serverUserId];
    const since = new Date(Date.now() - TIME_MS.DAY);
    // Both counts, so the variable can match whichever one a server-scoped condition read.
    const [last24h, last24hOnServer] = await Promise.all([
      countDownloads(ids, since),
      countDownloads(ids, since, args.serverId),
    ]);
    await dispatch(
      {
        type: 'account.media_downloaded',
        at: new Date(),
        server: context.server,
        serverUser: context.serverUser,
        session: null,
        download: {
          title: args.title,
          app: args.app,
          device: args.device,
          last24h,
          last24hOnServer,
        },
      },
      context.inputs
    );
  });
}

/** Every move a write made, announced after it committed; the skip above drops the no-ops. */
export async function dispatchTrustMoves(moves: TrustMove[], reason: string): Promise<void> {
  for (const move of moves) {
    await dispatchTrustChanged({
      serverId: move.serverUser.serverId,
      serverUserId: move.serverUser.id,
      previous: move.previous,
      next: move.serverUser.trustScore,
      reason,
    });
  }
}

/**
 * The dashboard's health banner is an operations indicator, so it goes out whether or
 * not an automation listens, and a failed publish never costs the dispatch.
 */
async function publishServerHealth(
  type: 'server.down' | 'server.up',
  server: EvaluationServer,
  reason?: ServerDownReason
): Promise<void> {
  const event = type === 'server.down' ? WS_EVENTS.SERVER_DOWN : WS_EVENTS.SERVER_UP;
  try {
    await getPubSubService()?.publish(event, {
      serverId: server.id,
      serverName: server.name,
      ...(reason && { reason }),
    });
  } catch (error) {
    automationsLogger.warn('Server health publish failed', { event, serverId: server.id, error });
  }
}

/** The poller holds the server row its health check just flipped. */
export async function dispatchServerHealth(
  type: 'server.down' | 'server.up',
  server: EvaluationServer,
  at: Date,
  reason?: ServerDownReason
): Promise<void> {
  await guarded(type, async () => {
    if (!(await isLiveServer(server.id))) return;
    await publishServerHealth(type, server, reason);
    const rules = await serverListeningRules(type, server.id);
    if (!rules) return;
    const { inputs } = await serverContextFor(server, rules);
    await dispatch({ type, at, server }, inputs);
  });
}

/** The SSE fallback holds only an id, and its down timer fires long after the row was read. */
export async function dispatchServerHealthById(
  type: 'server.down' | 'server.up',
  serverId: string,
  at: Date
): Promise<void> {
  await guarded(type, async () => {
    if (!(await isLiveServer(serverId))) return;
    const rules = await serverListeningRules(type, serverId);
    // The banner needs the name either way, so the row is read whether or not anything listens.
    const context = await loadServerContext(serverId, rules ?? []);
    if (!context) return;
    await publishServerHealth(type, context.server);
    if (!rules) return;
    await dispatch({ type, at, server: context.server }, context.inputs);
  });
}

export async function dispatchPluginUpdate(args: {
  server: EvaluationServer;
  installedVersion: string | null;
  latestVersion: string;
  downloadUrl: string;
}): Promise<void> {
  await guarded('plugin.update_available', async () => {
    const rules = await serverListeningRules('plugin.update_available', args.server.id);
    if (!rules) return;
    const { inputs } = await serverContextFor(args.server, rules);
    await dispatch({ type: 'plugin.update_available', at: new Date(), ...args }, inputs);
  });
}

export async function dispatchServerUpdate(args: {
  server: EvaluationServer;
  installedVersion: string;
  latestVersion: string;
  releaseUrl: string;
}): Promise<void> {
  await guarded('server.update_available', async () => {
    const rules = await serverListeningRules('server.update_available', args.server.id);
    if (!rules) return;
    const { inputs } = await serverContextFor(args.server, rules);
    await dispatch({ type: 'server.update_available', at: new Date(), ...args }, inputs);
  });
}

// A media subject reads nothing from the session inputs, and a sync run dispatches per item.
export async function dispatchMediaAdded(args: {
  server: EvaluationServer;
  media: MediaSubject;
}): Promise<void> {
  await guarded('media.added', async () => {
    const rules = await serverListeningRules('media.added', args.server.id);
    if (!rules) return;
    await dispatch({ type: 'media.added', at: new Date(), ...args }, installInputs(rules));
  });
}

export async function dispatchMediaUpgraded(args: {
  server: EvaluationServer;
  media: MediaSubject;
  from: MediaQuality;
  changed: (keyof MediaQuality)[];
}): Promise<void> {
  await guarded('media.upgraded', async () => {
    const rules = await serverListeningRules('media.upgraded', args.server.id);
    if (!rules) return;
    await dispatch({ type: 'media.upgraded', at: new Date(), ...args }, installInputs(rules));
  });
}

export async function dispatchTracearrUpdate(args: {
  current: string;
  latest: string;
  releaseUrl: string;
}): Promise<void> {
  await guarded('tracearr.update_available', async () => {
    const rules = await listeningRules('tracearr.update_available');
    if (!rules) return;
    await dispatch(
      { type: 'tracearr.update_available', at: new Date(), ...args },
      installInputs(rules)
    );
  });
}

/** A finished send announces itself once its outcome is written; which trigger fires follows the outcome. */
export async function dispatchNewsletterSend(fields: NewsletterSendPayload): Promise<void> {
  const trigger = fields.outcome === 'sent' ? 'newsletter.sent' : 'newsletter.failed';
  await guarded(trigger, async () => {
    const rules = await listeningRules(trigger);
    if (!rules) return;
    await dispatch({ type: trigger, at: new Date(), ...fields }, installInputs(rules));
  });
}
