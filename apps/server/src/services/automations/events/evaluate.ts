import { TIME_MS, TRIGGER_TYPES, type EngineAutomation, type TriggerNode } from '@tracearr/shared';

import { ruleAppliesTo } from '../engine.js';
import { pauseMinutes } from '../wakes/crossings.js';
import { buildRuleContextSessions, toRuleServer, toRuleServerUser } from './contextAssembly.js';
import type { EvaluationContext } from '../types.js';
import type {
  AccountInactiveForEvent,
  AccountNewDeviceEvent,
  AccountTrustChangedEvent,
  EvaluationInputs,
  MediaAddedEvent,
  MediaUpgradedEvent,
  PluginUpdateEvent,
  ServerDownEvent,
  ServerUpdateEvent,
  ServerUpEvent,
  SessionFirstSeenEvent,
  SessionHeldForEvent,
  SessionPausedEvent,
  SessionStartedEvent,
  SessionStoppedEvent,
  SessionTranscodeChangedEvent,
  TracearrUpdateEvent,
  TriggerType,
} from './types.js';

export type SessionEvaluatingEvent =
  | SessionStartedEvent
  | SessionFirstSeenEvent
  | SessionStoppedEvent
  | SessionTranscodeChangedEvent
  | SessionPausedEvent
  | SessionHeldForEvent
  | AccountNewDeviceEvent;

/** The events that carry the account a run is about. */
export type UserEvaluatingEvent =
  SessionEvaluatingEvent | AccountInactiveForEvent | AccountTrustChangedEvent;

/** The events about a server and nobody on it. */
export type ServerEvaluatingEvent =
  ServerDownEvent | ServerUpEvent | PluginUpdateEvent | ServerUpdateEvent;

/** The events about one library item on a server. */
export type MediaEvaluatingEvent = MediaAddedEvent | MediaUpgradedEvent;

/** One per catalog trigger: every event that carries a context to evaluate in. */
export type ContextEvaluatingEvent =
  UserEvaluatingEvent | MediaEvaluatingEvent | ServerEvaluatingEvent | TracearrUpdateEvent;

// The seam declares three trigger types the catalog does not: resumed, media_changed and
// ended only cancel wakes and must never reach evaluation even if a stored node names one.
const EVALUATING_TRIGGERS: ReadonlySet<string> = new Set(TRIGGER_TYPES);

/** The enabled stored node that makes this rule run for the trigger, if it has one. */
export function triggerNodeFor(
  rule: Pick<EngineAutomation, 'triggers'>,
  trigger: TriggerType
): TriggerNode | null {
  return rule.triggers.find((node) => node.enabled && node.type === trigger) ?? null;
}

/** A rule runs for a trigger when its stored triggers hold an enabled node of that type. */
export function matchesTrigger(
  rule: Pick<EngineAutomation, 'triggers'>,
  trigger: TriggerType
): boolean {
  return triggerNodeFor(rule, trigger) !== null;
}

/** Whole days since the account last did anything; null when it never has, which outlasts any threshold. */
function inactiveDays(lastActivityAt: Date | null, at: Date): number | null {
  if (!lastActivityAt) return null;
  return Math.floor((at.getTime() - lastActivityAt.getTime()) / TIME_MS.DAY);
}

/** Params are the trigger's own test: held_for and inactive_for fire only once the event clears the node. */
export function paramsPass(node: TriggerNode, event: ContextEvaluatingEvent): boolean {
  if (node.type === 'session.held_for') {
    if (event.type !== 'session.held_for' || !event.pauseData.lastPausedAt) return false;
    const minutes = pauseMinutes(node.params.measure, {
      lastPausedAt: event.pauseData.lastPausedAt.getTime(),
      pausedDurationMs: event.pauseData.pausedDurationMs,
      now: event.at.getTime(),
    });
    return minutes >= node.params.minutes;
  }
  if (node.type === 'account.inactive_for') {
    if (event.type !== 'account.inactive_for') return false;
    const days = inactiveDays(event.serverUser.lastActivityAt, event.at);
    return days === null || days >= node.params.days;
  }
  return true;
}

/**
 * The node this event fires: the one the wake named, else the first enabled node of the type whose
 * params pass. The fallback keeps a near miss able to name a node when nothing passes.
 */
export function firingNodeFor(
  rule: Pick<EngineAutomation, 'triggers'>,
  event: ContextEvaluatingEvent
): TriggerNode | null {
  const nodes = rule.triggers.filter((node) => node.enabled && node.type === event.type);
  const named =
    event.type === 'session.held_for' && event.triggerNodeId
      ? nodes.find((node) => node.id === event.triggerNodeId)
      : undefined;
  return named ?? nodes.find((node) => paramsPass(node, event)) ?? nodes[0] ?? null;
}

export function rulesForTrigger(
  trigger: TriggerType,
  rules: EngineAutomation[]
): EngineAutomation[] {
  if (!EVALUATING_TRIGGERS.has(trigger)) return [];
  return rules.filter((rule) => matchesTrigger(rule, trigger));
}

export interface TriggerCandidates {
  rules: EngineAutomation[];
  baseContext: Omit<EvaluationContext, 'rule'>;
}

/** The context an event carries: whatever it does not name is null. */
function baseContextOf(
  event: ContextEvaluatingEvent,
  inputs: EvaluationInputs,
  subjectKey: string
): Omit<EvaluationContext, 'rule'> {
  if (!('serverUser' in event)) {
    return {
      session: null,
      serverUser: null,
      server: 'server' in event ? toRuleServer(event.server) : null,
      media: 'media' in event ? event.media : null,
      subjectKey,
      trigger: event,
      activeSessions: inputs.activeSessions,
      recentSessions: [],
      identityServerUserIds: [],
    };
  }
  const session = event.session;
  return {
    session,
    serverUser: toRuleServerUser(event.serverUser, event.server.id),
    server: toRuleServer(event.server),
    media: null,
    subjectKey,
    trigger: event,
    activeSessions: session
      ? buildRuleContextSessions(inputs.activeSessions, session, null)
      : inputs.activeSessions,
    recentSessions: inputs.recentSessions,
    identityServerUserIds: inputs.identityServerUserIds ?? event.serverUser.identityServerUserIds,
  };
}

/** The rules this event can evaluate and the context to evaluate them in. Touches no database. */
export function triggerCandidates(
  event: ContextEvaluatingEvent,
  inputs: EvaluationInputs,
  subjectKey: string
): TriggerCandidates {
  const baseContext = baseContextOf(event, inputs, subjectKey);
  const rules = rulesForTrigger(event.type, inputs.activeAutomations).filter((rule) =>
    ruleAppliesTo(rule, baseContext)
  );
  return { rules, baseContext };
}
