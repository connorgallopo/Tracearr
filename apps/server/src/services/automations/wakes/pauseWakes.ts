import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { EngineAutomation } from '@tracearr/shared';
import { db } from '../../../db/client.js';
import { sessions } from '../../../db/schema.js';
import { sessionRowById } from '../../../db/sessions/row.js';
import { getActiveAutomations, onActiveAutomationsRefill } from '../../../jobs/poller/database.js';
import { broadcastViolations } from '../../../jobs/poller/violations.js';
import { automationsLogger } from '../../../utils/logger.js';
import { isLeader } from '../../leaderLease.js';
import { loadEvaluationContext, toRuleSession } from '../events/contextAssembly.js';
import { dispatch, subscribe } from '../events/dispatcher.js';
import { heldForNodes, pauseCrossings } from './crossings.js';
import type { PubSubService } from '../../cache.js';

const MAX_TIMER_MS = 2 ** 31 - 1;
/** A wake whose evaluation threw retries on a fixed cadence; the crossing math would drop a one-shot rule whose boundary just passed. */
const RETRY_MS = 30_000;

interface PendingWake {
  timer: ReturnType<typeof setTimeout>;
  startedAt: Date;
  fireAt: number;
  anchor: number;
  /** The held_for node this wake is for; null when it is the compound-rule recheck. */
  nodeId: string | null;
  gen: number;
}

interface PausedSessionLike {
  id: string;
  startedAt: Date;
  lastPausedAt: Date | null;
  pausedDurationMs: number | null;
}

const pending = new Map<string, PendingWake>();
let generation = 0;
let deps: { pubSubService: Pick<PubSubService, 'publish'> | null } = { pubSubService: null };
let lastFingerprint: string | null = null;
let registered = false;

export function setPauseWakeDeps(next: {
  pubSubService: Pick<PubSubService, 'publish'> | null;
}): void {
  deps = next;
}

export function pendingWakeCount(): number {
  return pending.size;
}

/** Set or replace the one timer for a paused session; a null crossing cancels it. Leader only. */
export function schedulePauseWake(
  session: PausedSessionLike,
  rules: EngineAutomation[],
  opts: { evaluateIfPast?: boolean } = {}
): void {
  cancelPauseWake(session.id);
  if (!isLeader() || !session.lastPausedAt) return;

  const now = Date.now();
  const anchor = session.lastPausedAt.getTime();
  const { next, earliest } = pauseCrossings({
    lastPausedAt: anchor,
    pausedDurationMs: session.pausedDurationMs ?? 0,
    now,
    rules,
  });

  const overdue = opts.evaluateIfPast && earliest !== null && earliest.at <= now;
  const crossing = overdue && earliest ? { at: now, nodeId: earliest.nodeId } : next;
  if (crossing) arm(session.id, session.startedAt, crossing.at, anchor, crossing.nodeId);
}

export function cancelPauseWake(sessionId: string): void {
  const entry = pending.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(sessionId);
}

/** stopProducers calls this on demotion; without it a former leader's timers keep firing. */
export function stopPauseWakes(): void {
  for (const id of Array.from(pending.keys())) cancelPauseWake(id);
}

function arm(
  sessionId: string,
  startedAt: Date,
  fireAt: number,
  anchor: number,
  nodeId: string | null
): void {
  cancelPauseWake(sessionId);
  const gen = ++generation;
  const delay = Math.min(Math.max(0, fireAt - Date.now()), MAX_TIMER_MS);
  const timer = setTimeout(() => void fire(sessionId, gen), delay);
  pending.set(sessionId, { timer, startedAt, fireAt, anchor, nodeId, gen });
}

/** The entry stays in `pending` while its fire is in flight; a cancel or a newer schedule replaces it and the stale fire bails at its next check. */
function owned(sessionId: string, gen: number): PendingWake | null {
  const entry = pending.get(sessionId);
  return entry?.gen === gen ? entry : null;
}

function readSession(sessionId: string, startedAt: Date) {
  return db
    .select()
    .from(sessions)
    .where(sessionRowById({ id: sessionId, startedAt }))
    .limit(1);
}

async function fire(sessionId: string, gen: number): Promise<void> {
  const entry = owned(sessionId, gen);
  if (!entry) return;
  const now = Date.now();
  // Timers can land early; re-arm for the remainder rather than evaluate before the boundary.
  if (now < entry.fireAt) {
    arm(sessionId, entry.startedAt, entry.fireAt, entry.anchor, entry.nodeId);
    return;
  }

  try {
    const [row] = await readSession(sessionId, entry.startedAt);
    if (!owned(sessionId, gen)) return;
    if (row?.state !== 'paused' || row.stoppedAt || !row.lastPausedAt) {
      cancelPauseWake(sessionId);
      return;
    }

    const rules = await getActiveAutomations();
    if (!owned(sessionId, gen)) return;
    if (row.lastPausedAt.getTime() !== entry.anchor) {
      schedulePauseWake(row, rules);
      return;
    }

    const ctx = await loadEvaluationContext(row.serverId, row.serverUserId, rules);
    if (!owned(sessionId, gen)) return;
    if (!ctx) {
      cancelPauseWake(sessionId);
      return;
    }

    const { violations } = await dispatch(
      {
        type: 'session.held_for',
        at: new Date(now),
        server: ctx.server,
        serverUser: ctx.serverUser,
        session: toRuleSession(row),
        pauseData: { lastPausedAt: row.lastPausedAt, pausedDurationMs: row.pausedDurationMs },
        heldMinutes: (now - row.lastPausedAt.getTime()) / 60_000,
        ...(entry.nodeId ? { triggerNodeId: entry.nodeId } : {}),
      },
      ctx.inputs
    );
    if (violations.length > 0 && deps.pubSubService) {
      await broadcastViolations(violations, row, deps.pubSubService);
    }
    if (owned(sessionId, gen)) schedulePauseWake(row, rules);
  } catch (error) {
    automationsLogger.error('Pause wake failed', { sessionId, error });
    if (owned(sessionId, gen)) {
      arm(sessionId, entry.startedAt, Date.now() + RETRY_MS, entry.anchor, entry.nodeId);
    }
  }
}

/** Every paused row gets a wake; crossings already behind us evaluate now. Leader acquire and pause-rule changes. */
export async function rehydratePauseWakes(): Promise<void> {
  if (!isLeader()) return;
  const rules = await getActiveAutomations();
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.state, 'paused'),
        isNotNull(sessions.lastPausedAt),
        isNull(sessions.stoppedAt)
      )
    );
  for (const row of rows) schedulePauseWake(row, rules, { evaluateIfPast: true });
}

/** Only what moves a crossing: which rules hold a held_for node, and on what threshold. */
function pauseRulesFingerprint(rules: EngineAutomation[]): string {
  const parts: string[] = [];
  for (const rule of rules) {
    if (!rule.isActive) continue;
    for (const node of heldForNodes(rule)) {
      parts.push(`${rule.id}:${node.params.measure}:${String(node.params.minutes)}`);
    }
  }
  return parts.sort().join('|');
}

export function registerPauseWakeSubscriptions(): void {
  if (registered) return;
  registered = true;

  subscribe('session.paused', 'pause-wakes', async (event, inputs) => {
    if (inputs) schedulePauseWake(event.session, inputs.activeAutomations);
  });
  subscribe('session.started', 'pause-wakes', async (event, inputs) => {
    if (inputs && event.session.state === 'paused' && event.session.lastPausedAt) {
      schedulePauseWake(event.session, inputs.activeAutomations);
    }
  });
  subscribe('session.resumed', 'pause-wakes', async (event) => cancelPauseWake(event.sessionId));
  subscribe('session.ended', 'pause-wakes', async (event) => cancelPauseWake(event.sessionId));
  subscribe('session.media_changed', 'pause-wakes', async (event) =>
    cancelPauseWake(event.sessionId)
  );

  onActiveAutomationsRefill((rules) => {
    const fp = pauseRulesFingerprint(rules);
    if (fp === lastFingerprint) return;
    // The first fill is a baseline, not a change; startProducers already rehydrates.
    const baseline = lastFingerprint === null;
    lastFingerprint = fp;
    if (baseline || !isLeader()) return;
    void rehydratePauseWakes().catch((error: unknown) => {
      automationsLogger.error('Pause wake rehydrate failed', { error });
    });
  });
}

export function resetPauseWakesForTests(): void {
  stopPauseWakes();
  registered = false;
  lastFingerprint = null;
}
