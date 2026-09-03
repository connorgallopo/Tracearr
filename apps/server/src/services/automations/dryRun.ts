/**
 * What a draft automation would do against the sessions playing right now. The
 * real evaluator on the real context, with nothing recorded, nothing enqueued and
 * no cooldown or notification gate consulted.
 */

import { TRIGGERS } from '@tracearr/shared';
import type {
  Action,
  AuthUser,
  CreateAutomationInput,
  DryRunAction,
  DryRunCondition,
  DryRunResponse,
  DryRunSample,
  DryRunSubject,
  EngineAutomation,
  GroupEvidence,
  Session,
  TriggerNode,
  TriggerType,
} from '@tracearr/shared';
import { filterByServerAccess } from '../../utils/serverFiltering.js';
import { evaluateAllGroupsAsync, evaluateRulesAsync, stoppedSummary } from './engine.js';
import { loadEvaluationContext } from './events/contextAssembly.js';
import { triggerCandidates } from './events/evaluate.js';
import { stampNodes } from './triggers.js';
import { storedSeverity } from './versions.js';
import type { EvaluationContext, EvaluationResult } from './types.js';
import type { EvaluationServer } from './events/types.js';

/** How many live sessions one check may cover; the builder debounces and re-asks. */
export const DRY_RUN_SESSION_CAP = 25;

const UNMATCHED = 'conditions did not match';
const NOT_TAKEN = 'branch not taken';

/** The id the response addresses a node by; an unstamped one takes its place in the list. */
const nodeIdOf = (action: Action, position: number): string =>
  action.id ?? `${action.type}@${String(position)}`;

/** The draft as the engine reads it: never stored, so it carries no version and no row id. */
export function toEngineAutomation(definition: CreateAutomationInput): EngineAutomation {
  const stamped = stampNodes({ conditions: definition.conditions, actions: definition.actions });
  const now = new Date();
  return {
    id: 'dry-run',
    name: definition.name,
    description: definition.description ?? null,
    serverId: definition.serverId ?? null,
    serverUserId: definition.serverUserId ?? null,
    userId: definition.userId ?? null,
    enforceAcrossServers: definition.enforceAcrossServers ?? false,
    isActive: true,
    severity: storedSeverity(definition.severity),
    kind: definition.kind,
    conditions: stamped.conditions ?? { groups: [] },
    actions: stamped.actions,
    triggers: definition.triggers,
    currentVersionId: null,
    cooldownMinutes: definition.cooldownMinutes ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/** The enabled triggers a playing session can carry, deduplicated by type. */
function sessionTriggersOf(triggers: TriggerNode[]): TriggerType[] {
  const types = triggers
    .filter((node) => node.enabled && TRIGGERS[node.type].context === 'session')
    // A live session cannot be re-tested for device newness: its own row already matches.
    .filter((node) => node.type !== 'account.new_device')
    .map((node) => node.type);
  return [...new Set(types)];
}

/** Evidence carries no node id, so the enabled conditions are walked in the order it holds them. */
function conditionsOf(automation: EngineAutomation, evidence: GroupEvidence[]): DryRunCondition[] {
  const out: DryRunCondition[] = [];
  for (const group of evidence) {
    const stored = automation.conditions.groups[group.groupIndex];
    if (!stored) continue;
    const enabled = stored.conditions.filter((condition) => condition.enabled !== false);
    for (const [index, item] of group.conditions.entries()) {
      const nodeId = enabled[index]?.id;
      if (!nodeId) continue;
      out.push({ nodeId, passed: item.matched, evidence: item });
    }
  }
  return out;
}

// Every sample carries a session, so kill_stream, message_client and trust all have a
// subject to name; a replayed session that already stopped has nothing left to act on,
// which the summary says rather than the verdict.
function actionVerdict(
  nodeId: string,
  action: Action,
  matched: boolean,
  taken = true
): DryRunAction {
  if (action.enabled === false) return { nodeId, wouldRun: false, reason: 'disabled' };
  if (!matched) return { nodeId, wouldRun: false, reason: UNMATCHED };
  if (!taken) return { nodeId, wouldRun: false, reason: NOT_TAKEN };
  return { nodeId, wouldRun: true };
}

/** An `if` reads the same context the automation's own conditions did; nothing executes. */
async function actionsOf(
  context: EvaluationContext,
  actions: Action[],
  matched: boolean
): Promise<DryRunAction[]> {
  const out: DryRunAction[] = [];
  for (const [index, action] of actions.entries()) {
    const nodeId = nodeIdOf(action, index);
    if (action.type !== 'if' || action.enabled === false) {
      out.push(actionVerdict(nodeId, action, matched));
      continue;
    }
    const { matchedGroups } = await evaluateAllGroupsAsync(context, action.conditions);
    const branch = matchedGroups !== null ? 'then' : 'else';
    out.push({ ...actionVerdict(nodeId, action, matched), branch });
    for (const side of ['then', 'else'] as const) {
      for (const [leafIndex, leaf] of action[side].entries()) {
        const leafId = leaf.id ?? `${nodeId}.${side}.${String(leafIndex)}`;
        out.push(actionVerdict(leafId, leaf, matched, side === branch));
      }
    }
  }
  return out;
}

function summaryOf(
  subject: DryRunSubject,
  result: EvaluationResult,
  standIns: TriggerType[],
  session: Session
): string {
  const who = `${subject.user.name} on ${subject.server.name}`;
  const head = result.matched
    ? `Would run for ${who}`
    : `Would not run for ${who}: ${stoppedSummary(result.stoppedBy)}`;
  const notes: string[] = [];
  if (session.state === 'stopped') notes.push('This session has already stopped.');
  if (standIns.length > 0) {
    notes.push(
      `Checked against the session's current state rather than a ${standIns.join(' or ')} event.`
    );
  }
  return [`${head}.`, ...notes].join(' ');
}

/** A matched walk carries every group; a stopped one keeps only the group that ended it. */
const evidenceOf = (result: EvaluationResult): GroupEvidence[] =>
  result.evidence ?? (result.stoppedBy ? [result.stoppedBy] : []);

async function sampleFor(
  automation: EngineAutomation,
  triggers: TriggerType[],
  session: Session,
  knownServers: Map<string, EvaluationServer>
): Promise<DryRunSample | null> {
  const loaded = await loadEvaluationContext(
    session.serverId,
    session.serverUserId,
    [automation],
    knownServers.get(session.serverId)
  );
  if (!loaded) return null;
  knownServers.set(loaded.server.id, loaded.server);
  const { server, serverUser, inputs } = loaded;
  const subject: DryRunSubject = {
    sessionId: session.id,
    user: { id: serverUser.id, name: serverUser.identityName ?? serverUser.username },
    server: { id: server.id, name: server.name },
  };

  // A dry run has no event to replay: a draft that only fires on a pause or a transcode
  // change still gets its conditions read against the session as it is right now.
  const { baseContext } = triggerCandidates(
    { type: 'session.started', at: new Date(), server, serverUser, session },
    inputs,
    session.id
  );
  // first_seen evaluates the same live-session shape, so it needs no stand-in note either.
  const standIns =
    triggers.includes('session.started') || triggers.includes('session.first_seen') ? [] : triggers;

  const [result] = await evaluateRulesAsync(baseContext, [automation], { includeUnmatched: true });
  if (!result) {
    return {
      subject,
      triggers,
      conditions: [],
      actions: [],
      wouldRun: false,
      summary: `Would not run for ${subject.user.name} on ${subject.server.name}: the automation is scoped elsewhere.`,
    };
  }

  const context: EvaluationContext = { ...baseContext, rule: automation };
  return {
    subject,
    triggers,
    conditions: conditionsOf(automation, evidenceOf(result)),
    actions: await actionsOf(context, automation.actions.actions, result.matched),
    wouldRun: result.matched,
    summary: summaryOf(subject, result, standIns, session),
  };
}

export async function dryRun(args: {
  definition: CreateAutomationInput;
  sessions: Session[];
  user: AuthUser;
}): Promise<DryRunResponse> {
  const automation = toEngineAutomation(args.definition);
  const triggers = sessionTriggersOf(automation.triggers);
  if (triggers.length === 0) return { samples: [] };

  const visible = filterByServerAccess(args.sessions, args.user).slice(0, DRY_RUN_SESSION_CAP);
  // Sessions cluster on a handful of servers; one read each covers the whole check.
  const knownServers = new Map<string, EvaluationServer>();
  const samples: DryRunSample[] = [];
  for (const session of visible) {
    const sample = await sampleFor(automation, triggers, session, knownServers);
    if (sample) samples.push(sample);
  }
  return { samples };
}
