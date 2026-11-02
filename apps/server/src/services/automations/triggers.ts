import { randomUUID } from 'node:crypto';
import { automationsLogger } from '../../utils/logger.js';
import type {
  Action,
  Condition,
  ConditionField,
  NodeFields,
  AutomationActions,
  AutomationConditions,
  TriggerNode,
  TriggerType,
} from '@tracearr/shared';

const TRANSCODE_FIELDS: ReadonlySet<ConditionField> = new Set([
  'is_transcoding',
  'is_transcode_downgrade',
  'is_subtitle_burn_in',
  'output_resolution',
]);
const PAUSE_FIELDS: ReadonlySet<ConditionField> = new Set([
  'current_pause_minutes',
  'total_pause_minutes',
]);

const node = (
  type: Exclude<TriggerType, 'session.held_for' | 'account.inactive_for'>
): TriggerNode => ({ id: randomUUID(), type, enabled: true });

const PAUSE_MEASURE: Partial<Record<ConditionField, 'current' | 'total'>> = {
  current_pause_minutes: 'current',
  total_pause_minutes: 'total',
};
const RISING_OPERATORS: ReadonlySet<string> = new Set(['gt', 'gte']);
/** What a rule with nothing to derive from gets; disabled, so it fires nothing until someone sets it. */
export const DEFAULT_HELD_FOR = { minutes: 30, measure: 'current' } as const;
export const DEFAULT_INACTIVE_FOR = { days: 30 } as const;

function* enabledConditions(conditions: AutomationConditions | null | undefined) {
  for (const group of conditions?.groups ?? []) {
    for (const condition of group.conditions) {
      if (condition.enabled !== false) yield condition;
    }
  }
}

/** A threshold the trigger schema would reject is no threshold at all; the node lands disabled instead. */
function threshold(condition: Condition, max: number, automationId?: string): number | null {
  const { value } = condition;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max) {
    return value;
  }
  automationsLogger.warn('Condition threshold outside the trigger range; node stamped disabled', {
    automationId: automationId ?? null,
    field: condition.field,
    operator: condition.operator,
    value,
  });
  return null;
}

export interface HeldForParams {
  minutes: number;
  measure: 'current' | 'total';
}

/** Every distinct measure and threshold among the rising pause conditions, in condition order. */
export function heldForThresholds(
  conditions: AutomationConditions | null | undefined,
  automationId?: string
): HeldForParams[] {
  const found: HeldForParams[] = [];
  const seen = new Set<string>();
  for (const condition of enabledConditions(conditions)) {
    const measure = PAUSE_MEASURE[condition.field];
    if (!measure || !RISING_OPERATORS.has(condition.operator)) continue;
    const minutes = threshold(condition, 1440, automationId);
    if (minutes === null || seen.has(`${measure}:${String(minutes)}`)) continue;
    seen.add(`${measure}:${String(minutes)}`);
    found.push({ minutes, measure });
  }
  return found;
}

/** The first enabled inactive_days threshold, which is what the evaluator applies today. */
export function inactiveForDays(
  conditions: AutomationConditions | null | undefined,
  automationId?: string
): number | null {
  for (const condition of enabledConditions(conditions)) {
    if (condition.field !== 'inactive_days') continue;
    const days = threshold(condition, 3650, automationId);
    if (days !== null) return days;
  }
  return null;
}

/** One node per threshold the pause conditions imply, or a disabled default when they imply none. */
function heldForNodes(
  conditions: AutomationConditions | null | undefined,
  automationId?: string
): TriggerNode[] {
  const thresholds = heldForThresholds(conditions, automationId);
  if (thresholds.length === 0) {
    return [
      {
        id: randomUUID(),
        type: 'session.held_for',
        enabled: false,
        params: { ...DEFAULT_HELD_FOR },
      },
    ];
  }
  return thresholds.map((params) => ({
    id: randomUUID(),
    type: 'session.held_for',
    enabled: true,
    params,
  }));
}

function inactiveForNode(
  conditions: AutomationConditions | null | undefined,
  automationId?: string
): TriggerNode {
  const days = inactiveForDays(conditions, automationId);
  return days === null
    ? {
        id: randomUUID(),
        type: 'account.inactive_for',
        enabled: false,
        params: { ...DEFAULT_INACTIVE_FOR },
      }
    : { id: randomUUID(), type: 'account.inactive_for', enabled: true, params: { days } };
}

/**
 * Mirrors the engine's condition sniffing: inactive_days routes to the account trigger and
 * suppresses session.started, while transcode and pause fields add their edge triggers either way.
 * The pause and inactivity thresholds move onto the nodes they now belong to.
 */
export function synthesizeTriggers(
  conditions: AutomationConditions | null | undefined,
  automationId?: string
): TriggerNode[] {
  const fields = new Set<string>();
  for (const group of conditions?.groups ?? []) {
    for (const condition of group.conditions) fields.add(condition.field);
  }
  const usesAny = (candidates: ReadonlySet<ConditionField>): boolean =>
    [...candidates].some((field) => fields.has(field));

  const triggers: TriggerNode[] = [];
  if (!fields.has('inactive_days')) triggers.push(node('session.started'));
  if (usesAny(TRANSCODE_FIELDS)) triggers.push(node('session.transcode_changed'));
  if (usesAny(PAUSE_FIELDS)) {
    triggers.push(node('session.paused'), ...heldForNodes(conditions, automationId));
  }
  if (fields.has('inactive_days')) triggers.push(inactiveForNode(conditions, automationId));
  return triggers;
}

/**
 * A trigger type that survives an edit keeps the node id it already had. The
 * notification gate reads that id off past runs, so a fresh one re-notifies
 * every subject the automation has already reached.
 */
export function carryTriggerIds(
  next: TriggerNode[],
  existing: TriggerNode[] | null | undefined
): TriggerNode[] {
  const byType = new Map<TriggerNode['type'], string>();
  for (const trigger of existing ?? []) {
    byType.getOrInsert(trigger.type, trigger.id);
  }
  return next.map((trigger) => {
    const priorId = byType.get(trigger.type);
    if (priorId === undefined) return trigger;
    // One id per type: a second node of the same type would collide with the first.
    byType.delete(trigger.type);
    return { ...trigger, id: priorId };
  });
}

const stamp = <T extends NodeFields>(item: T): T & Required<NodeFields> => ({
  ...item,
  id: item.id ?? randomUUID(),
  enabled: item.enabled ?? true,
});

const stampGroups = (conditions: AutomationConditions): AutomationConditions => ({
  groups: conditions.groups.map((group) => ({
    ...stamp(group),
    conditions: group.conditions.map((condition) => stamp(condition)),
  })),
});

/** A branch holds a set of checks and two lists of steps, each addressed by id of its own. */
const stampAction = (action: Action): Action =>
  action.type === 'if'
    ? {
        ...stamp(action),
        conditions: stampGroups(action.conditions),
        then: action.then.map((leaf) => stamp(leaf)),
        else: action.else.map((leaf) => stamp(leaf)),
      }
    : stamp(action);

/** The builder addresses nodes by id, so every node needs one before it is stored. */
export function stampNodes(definition: {
  conditions: AutomationConditions | null;
  actions: AutomationActions | null;
}): { conditions: AutomationConditions | null; actions: AutomationActions } {
  return {
    conditions: definition.conditions ? stampGroups(definition.conditions) : null,
    actions: { actions: (definition.actions?.actions ?? []).map(stampAction) },
  };
}
