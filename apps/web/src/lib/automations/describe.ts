/**
 * The one sentence that describes an automation, in fragments: the builder makes
 * each one clickable, the list joins them into a summary.
 */

import {
  formatConditionFieldValue,
  type AutomationKind,
  type TemplateDefinition,
  type TemplateInput,
  type TranscodingConditionValue,
  type TriggerType,
  type UnitSystem,
} from '@tracearr/shared';
import {
  fieldDescriptor,
  fieldOptions,
  isKnownField,
  isKnownOperator,
  optionLabel,
  unitLabel,
  type Translate,
} from './conditionFields';

/** One clause of the sentence, carrying the node it came from; null is connective text. */
export interface DescribeFragment {
  nodeId: string | null;
  text: string;
  /** Template inputs whose answers wrote this clause; a stored automation carries none. */
  inputKeys?: readonly string[];
}

/** A template leaves a value out until it is bound, naming the input that fills it. */
interface Placeholder {
  $input: string;
}

type DescribableTrigger = TemplateDefinition['triggers'][number];
type DescribableGroup = TemplateDefinition['conditions']['groups'][number];
type DescribableCondition = DescribableGroup['conditions'][number];
type DescribableAction = TemplateDefinition['actions']['actions'][number];
type DescribableLeaf = Exclude<DescribableAction, { type: 'if' }>;

/** A stored automation or a template's definition, whose values may still be placeholders. */
export interface DescribableDefinition {
  kind?: AutomationKind;
  triggers?: readonly DescribableTrigger[];
  conditions?: { groups: readonly DescribableGroup[] } | null;
  actions?: { actions: readonly DescribableAction[] } | null;
  /** A template keeps its scope here; a stored automation keeps it in the three columns. */
  scope?: TemplateDefinition['scope'];
  serverId?: string | null;
  serverUserId?: string | null;
  userId?: string | null;
}

/** The names behind the ids a sentence would otherwise print raw. */
export interface DescribeRefs {
  servers?: Record<string, string>;
  users?: Record<string, string>;
  countries?: Record<string, string>;
  accounts?: Record<string, string>;
  destinations?: Record<string, string>;
}

interface Describe {
  t: Translate;
  refs: DescribeRefs;
  unitSystem: UnitSystem;
  inputKinds: Readonly<Record<string, TemplateInput['kind']>>;
  /** Whether an empty part reads as an invitation to fill it, which only the builder wants. */
  placeholders: boolean;
}

/** What the caller wants of a half-built definition. */
export interface DescribeOptions {
  /** Names the empty trigger and action slots after the steps that fill them. */
  placeholders?: boolean;
  /** What kind of thing each template input holds, so an unanswered one reads as a noun. */
  inputKinds?: Readonly<Record<string, TemplateInput['kind']>>;
}

const SENTENCE_LIMIT = 160;

/**
 * Fragments that address a step of the builder rather than a node inside it, so an
 * empty slot and the settings behind the sentence still have somewhere to jump to.
 */
export const SENTENCE_SECTIONS = {
  triggers: 'triggers',
  actions: 'actions',
  kind: 'kind',
  scope: 'scope',
} as const;

/** The camelCase translation key for each trigger type. */
export const TRIGGER_KEYS = {
  'session.started': 'sessionStarted',
  'session.first_seen': 'sessionFirstSeen',
  'session.stopped': 'sessionStopped',
  'session.transcode_changed': 'sessionTranscodeChanged',
  'session.paused': 'sessionPaused',
  'session.held_for': 'sessionHeldFor',
  'account.inactive_for': 'accountInactiveFor',
  'account.new_device': 'accountNewDevice',
  'account.trust_changed': 'accountTrustChanged',
  'media.added': 'mediaAdded',
  'media.upgraded': 'mediaUpgraded',
  'server.down': 'serverDown',
  'server.up': 'serverUp',
  'plugin.update_available': 'pluginUpdateAvailable',
  'server.update_available': 'serverUpdateAvailable',
  'tracearr.update_available': 'tracearrUpdateAvailable',
} as const satisfies Record<TriggerType, string>;

/** Fields whose truth reads as a state, not as a comparison against `true`. */
const BOOLEAN_STATE_FIELDS = ['is_local_network', 'is_transcode_downgrade'] as const;

const TRANSCODING_VALUES = [
  'video',
  'audio',
  'video_or_audio',
  'neither',
] as const satisfies readonly TranscodingConditionValue[];

function isPlaceholder(value: unknown): value is Placeholder {
  return typeof value === 'object' && value !== null && '$input' in value;
}

function isEnabled(node: { enabled?: boolean | Placeholder }): boolean {
  return node.enabled !== false;
}

function isBooleanStateField(field: string): field is (typeof BOOLEAN_STATE_FIELDS)[number] {
  return (BOOLEAN_STATE_FIELDS as readonly string[]).includes(field);
}

function isTranscodingValue(value: unknown): value is TranscodingConditionValue {
  return typeof value === 'string' && (TRANSCODING_VALUES as readonly string[]).includes(value);
}

/**
 * Punctuation joins clauses, so it lands on the fragment its clause ends with. Only the
 * same mark is skipped: a truncated list ends in `...`, and the separator after it stands.
 */
function appendSuffix(fragments: DescribeFragment[], suffix: string): void {
  const last = fragments[fragments.length - 1];
  if (!last || last.text.endsWith(suffix)) return;
  fragments[fragments.length - 1] = { ...last, text: `${last.text}${suffix}` };
}

/** An `if` closes on a full stop, so whatever follows it opens a sentence. */
export function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/**
 * A required input nothing has answered reads as the kind of thing it holds, never as
 * the form's own label. An unknown key falls back to the plainest of the nouns.
 */
function placeholderText(ctx: Describe, placeholder: Placeholder): string {
  const kind = ctx.inputKinds[placeholder.$input] ?? 'field_value';
  return ctx.t(`automations.describe.unbound.${kind}`);
}

function durationText(
  ctx: Describe,
  value: number | Placeholder,
  unit: 'minutes' | 'days'
): string {
  if (isPlaceholder(value)) return placeholderText(ctx, value);
  return ctx.t(`automations.describe.duration.${unit}`, { count: value });
}

function describeTrigger(ctx: Describe, trigger: DescribableTrigger): string {
  const { t } = ctx;

  if (trigger.type === 'session.held_for') {
    const duration = durationText(ctx, trigger.params.minutes, 'minutes');
    return trigger.params.measure === 'total'
      ? t('automations.describe.triggers.sessionHeldForTotal', { duration })
      : t('automations.describe.triggers.sessionHeldFor', { duration });
  }

  if (trigger.type === 'account.inactive_for') {
    const duration = durationText(ctx, trigger.params.days, 'days');
    return t('automations.describe.triggers.accountInactiveFor', { duration });
  }

  return t(`automations.describe.triggers.${TRIGGER_KEYS[trigger.type]}`);
}

function describeTriggers(
  ctx: Describe,
  triggers: readonly DescribableTrigger[]
): DescribeFragment[] {
  const enabled = triggers.filter(isEnabled);
  if (enabled.length === 0) {
    if (!ctx.placeholders) {
      const text = ctx.t('automations.describe.when', {
        text: ctx.t('automations.describe.nothing'),
      });
      return [{ nodeId: null, text }];
    }
    const text = ctx.t('automations.describe.when', {
      text: ctx.t('automations.builder.sentence.placeholderTrigger'),
    });
    return [{ nodeId: SENTENCE_SECTIONS.triggers, text }];
  }

  return enabled.map((trigger, index) => ({
    nodeId: trigger.id,
    text: ctx.t(index === 0 ? 'automations.describe.when' : 'automations.describe.or', {
      text: describeTrigger(ctx, trigger),
    }),
  }));
}

/** A user, server or country id reads as its name once the refs carry one. */
function dynamicName(ctx: Describe, field: string, value: string): string | undefined {
  const source = fieldDescriptor(field)?.dynamicSource;
  return source ? ctx.refs[source]?.[value] : undefined;
}

function scalarText(ctx: Describe, field: string, value: string | boolean): string {
  if (typeof value === 'boolean') return String(value);
  const named = dynamicName(ctx, field, value);
  if (named) return named;
  return fieldOptions(ctx.t, field).find((option) => option.value === value)?.label ?? value;
}

function listText(ctx: Describe, field: string, values: readonly (string | number)[]): string {
  if (values.length === 0) return ctx.t('automations.describe.noValues');
  const labels = values.map((entry) =>
    typeof entry === 'number' ? String(entry) : scalarText(ctx, field, entry)
  );
  return labels.length > 3 ? `${labels.slice(0, 3).join(', ')}...` : labels.join(', ');
}

/** The threshold as the reader sees it: their unit system, and names where it holds ids. */
function conditionValue(ctx: Describe, condition: DescribableCondition): string {
  const { field, value } = condition;
  // "is one of a chosen value" is not English; a list slot needs the plural frame.
  if (isPlaceholder(value)) {
    return fieldDescriptor(field)?.valueType === 'multiSelect'
      ? ctx.t('automations.describe.unbound.listed')
      : placeholderText(ctx, value);
  }
  // A list already reads as a list; only a threshold takes a unit.
  if (Array.isArray(value)) return listText(ctx, field, value);

  if (typeof value === 'number') {
    const converted = formatConditionFieldValue(value, field, ctx.unitSystem);
    if (converted.unit) return `${converted.displayValue} ${converted.unit}`;
    const unit = fieldDescriptor(field)?.unit;
    return unit ? `${value} ${unitLabel(ctx.t, unit)}` : String(value);
  }

  return scalarText(ctx, field, value);
}

/** Params that change what a threshold counts, so the sentence has to say so. */
function conditionNotes(ctx: Describe, condition: DescribableCondition): string {
  const { t } = ctx;
  const { params } = condition;
  if (!params) return '';

  const notes: string[] = [];
  // exclude_same_device defaults to on, exclude_same_ip to off, so each shows when flipped.
  const sameDevice = params.exclude_same_device;
  if (isPlaceholder(sameDevice)) {
    const input = placeholderText(ctx, sameDevice);
    notes.push(t('automations.describe.sameDeviceInput', { input }));
  } else if (sameDevice === false) {
    notes.push(t('automations.describe.includesSameDevice'));
  }

  const uniqueIps = params.exclude_same_ip;
  if (isPlaceholder(uniqueIps)) {
    notes.push(
      t('automations.describe.uniqueIpsInput', { input: placeholderText(ctx, uniqueIps) })
    );
  } else if (uniqueIps === true) {
    notes.push(t('automations.describe.uniqueIps'));
  }

  if (params.count_device_types?.length) {
    const types = params.count_device_types.map((type) => optionLabel(t, type)).join('/');
    notes.push(t('automations.describe.deviceTypesOnly', { types }));
  }

  return notes.length > 0 ? ` (${notes.join(', ')})` : '';
}

/** Some fields read as a state ("the stream is transcoding") rather than a comparison. */
function stateClause(ctx: Describe, condition: DescribableCondition): string | null {
  const { field, operator, value } = condition;
  if (operator !== 'eq' && operator !== 'neq') return null;

  if (isBooleanStateField(field) && typeof value === 'boolean') {
    const positive = value === (operator === 'eq');
    return ctx.t(`automations.describe.states.${field}.${positive ? 'yes' : 'no'}`);
  }

  if (field === 'is_transcoding' && isTranscodingValue(value)) {
    const positive = operator === 'eq';
    return ctx.t(`automations.describe.states.is_transcoding.${value}.${positive ? 'yes' : 'no'}`);
  }

  return null;
}

function describeCondition(ctx: Describe, condition: DescribableCondition): string {
  const state = stateClause(ctx, condition);
  if (state) return state;

  const { t } = ctx;
  const { field, operator } = condition;
  // A stored automation can name a field or operator this build retired.
  const subject = isKnownField(field) ? t(`automations.describe.fields.${field}`) : field;
  const phrase = isKnownOperator(operator)
    ? t(`automations.describe.operators.${operator}`)
    : operator;

  return `${subject} ${phrase} ${conditionValue(ctx, condition)}${conditionNotes(ctx, condition)}`;
}

/**
 * The condition groups as fragments. `lead` opens the first group; the rest carry
 * "and also". Two conditions read as a sentence joined by "and" or "or"; three or
 * more take the list form, where the joining word would be lost among the commas.
 */
function describeGroups(
  ctx: Describe,
  groups: readonly DescribableGroup[],
  lead: string | null
): DescribeFragment[] {
  const fragments: DescribeFragment[] = [];

  for (const group of groups.filter(isEnabled)) {
    const conditions = group.conditions.filter(isEnabled);
    if (conditions.length === 0) continue;

    let connector = lead;
    if (fragments.length > 0) {
      appendSuffix(fragments, ';');
      connector = ctx.t('automations.describe.andAlso');
    }
    // A group saved before `match` existed matches any of its conditions.
    const all = group.match === 'all';
    const listed = conditions.length > 2;
    const match = listed
      ? ctx.t(all ? 'automations.describe.allOf' : 'automations.describe.anyOf')
      : null;
    const prefix = [connector, match].filter((part) => part !== null).join(' ');
    if (prefix) fragments.push({ nodeId: group.id ?? null, text: prefix });

    conditions.forEach((condition, index) => {
      if (index > 0) {
        if (listed) appendSuffix(fragments, ',');
        else {
          fragments.push({
            nodeId: null,
            text: ctx.t(all ? 'automations.describe.joinAll' : 'automations.describe.joinAny'),
          });
        }
      }
      fragments.push({ nodeId: condition.id ?? null, text: describeCondition(ctx, condition) });
    });
  }

  return fragments;
}

function trustText(ctx: Describe, action: Extract<DescribableLeaf, { type: 'trust' }>): string {
  const { t } = ctx;

  if (action.mode === 'reset') return t('automations.describe.actions.trustReset');
  if (action.mode === 'set') {
    const value = action.value;
    const target = isPlaceholder(value) ? placeholderText(ctx, value) : String(value);
    return t('automations.describe.actions.trustSet', { value: target });
  }

  const amount = action.amount;
  if (isPlaceholder(amount)) {
    return t('automations.describe.actions.trustAdjust', { amount: placeholderText(ctx, amount) });
  }
  const points = Math.abs(amount ?? 0);
  return amount !== undefined && amount < 0
    ? t('automations.describe.actions.trustDown', { amount: points })
    : t('automations.describe.actions.trustUp', { amount: points });
}

function leafText(ctx: Describe, action: DescribableLeaf): string {
  const { t } = ctx;

  switch (action.type) {
    case 'send': {
      // Nowhere to send yet is still a notification; the sentence never names the field.
      const names = isPlaceholder(action.to)
        ? []
        : action.to.map((id) => ctx.refs.destinations?.[id]).filter((name) => name !== undefined);
      return names.length > 0
        ? t('automations.describe.actions.send', { destinations: names.join(', ') })
        : t('automations.describe.actions.sendAnywhere');
    }
    case 'kill_stream':
      return t('automations.describe.actions.kill_stream');
    case 'message_client':
      return t('automations.describe.actions.message_client');
    case 'trust':
      return trustText(ctx, action);
  }
}

function describeAction(ctx: Describe, action: DescribableAction): DescribeFragment[] {
  const { t } = ctx;
  const nodeId = action.id ?? null;

  if (action.type !== 'if') return [{ nodeId, text: leafText(ctx, action) }];

  const fragments: DescribeFragment[] = [{ nodeId, text: t('automations.describe.actions.if') }];
  const conditions = describeGroups(ctx, action.conditions.groups, null);
  // A half-built `if` reads as one rather than trailing off into a comma.
  fragments.push(
    ...(conditions.length > 0
      ? conditions
      : [{ nodeId: null, text: t('automations.describe.nothing') }])
  );
  appendSuffix(fragments, ',');
  fragments.push(...describeBranch(ctx, action.then));
  appendSuffix(fragments, '.');
  fragments.push({ nodeId: null, text: t('automations.describe.otherwise') });
  fragments.push(...describeBranch(ctx, action.else));
  appendSuffix(fragments, '.');

  return fragments;
}

/** An empty branch still says so: the sentence has to close the `if`. */
function describeBranch(ctx: Describe, actions: readonly DescribableAction[]): DescribeFragment[] {
  const fragments = describeActions(ctx, actions);
  if (fragments.length > 0) return fragments;
  return [{ nodeId: null, text: ctx.t('automations.describe.actions.doNothing') }];
}

function describeActions(
  ctx: Describe,
  actions: readonly DescribableAction[],
  kind?: AutomationKind
): DescribeFragment[] {
  const fragments: DescribeFragment[] = [];
  // A policy records a violation whatever else it does, so the flag opens the clause.
  if (kind === 'policy') {
    fragments.push({
      nodeId: SENTENCE_SECTIONS.kind,
      text: ctx.t('automations.describe.actions.flagIt'),
    });
  }

  for (const action of actions.filter(isEnabled)) {
    const next = describeAction(ctx, action);
    const first = next[0];
    const previous = fragments[fragments.length - 1];

    if (first && previous) {
      if (previous.text.endsWith('.')) {
        next[0] = { ...first, text: capitalize(first.text) };
      } else {
        appendSuffix(fragments, ',');
        next[0] = { ...first, text: ctx.t('automations.describe.then', { text: first.text }) };
      }
    }

    fragments.push(...next);
  }

  return fragments;
}

function scopeName(
  ctx: Describe,
  id: string | Placeholder,
  names: Record<string, string> | undefined,
  fallback: 'server' | 'account' | 'person'
): string {
  if (isPlaceholder(id)) return placeholderText(ctx, id);
  return names?.[id] ?? ctx.t(`automations.describe.scope.${fallback}`);
}

function describeScope(ctx: Describe, definition: DescribableDefinition): DescribeFragment | null {
  const { serverId, serverUserId, userId } = definition.scope ?? definition;
  const { refs } = ctx;

  let name: string | null = null;
  if (serverId) name = scopeName(ctx, serverId, refs.servers, 'server');
  else if (serverUserId) name = scopeName(ctx, serverUserId, refs.accounts, 'account');
  else if (userId) name = scopeName(ctx, userId, refs.users, 'person');
  if (name === null) return null;

  return {
    nodeId: SENTENCE_SECTIONS.scope,
    text: ctx.t('automations.describe.appliesTo', { name }),
  };
}

/** A policy's flag opens a sentence of its own; other actions close the clause they follow. */
function actionSeparator(kind: AutomationKind | undefined, hasConditions: boolean): string {
  if (kind === 'policy') return '.';
  return hasConditions ? ';' : ',';
}

/** Just the condition groups, for a row that shows its own conditions and nothing else. */
export function describeConditions(
  groups: readonly DescribableGroup[],
  refs: DescribeRefs,
  t: Translate,
  unitSystem: UnitSystem
): DescribeFragment[] {
  return describeGroups({ t, refs, unitSystem, inputKinds: {}, placeholders: false }, groups, null);
}

/**
 * The whole automation as one sentence, fragment by fragment, as
 * "When a stream starts, only when the trust score is below 50; send to team-discord."
 */
export function describeAutomation(
  definition: DescribableDefinition,
  refs: DescribeRefs,
  t: Translate,
  unitSystem: UnitSystem,
  options: DescribeOptions = {}
): DescribeFragment[] {
  const placeholders = options.placeholders ?? false;
  const ctx: Describe = { t, refs, unitSystem, inputKinds: options.inputKinds ?? {}, placeholders };
  const triggers = definition.triggers ?? [];
  const actionNodes = definition.actions?.actions ?? [];
  // A draft with nothing on it invites both slots; "flag it" would name a control that is not there yet.
  const blank = placeholders && triggers.length === 0 && actionNodes.length === 0;

  const fragments = describeTriggers(ctx, triggers);

  const conditions = describeGroups(
    ctx,
    definition.conditions?.groups ?? [],
    t('automations.describe.onlyWhen')
  );
  if (conditions.length > 0) {
    appendSuffix(fragments, ',');
    fragments.push(...conditions);
  }

  const actions = blank ? [] : describeActions(ctx, actionNodes, definition.kind);
  if (actions.length > 0) {
    appendSuffix(fragments, actionSeparator(definition.kind, conditions.length > 0));
    fragments.push(...actions);
  } else if (placeholders) {
    appendSuffix(fragments, ',');
    fragments.push({
      nodeId: SENTENCE_SECTIONS.actions,
      text: t('automations.builder.sentence.placeholderAction'),
    });
  }
  appendSuffix(fragments, '.');

  const scope = describeScope(ctx, definition);
  if (scope) {
    fragments.push(scope);
    appendSuffix(fragments, '.');
  }

  return fragments;
}

/**
 * The fragments that fit in 160 characters, plus a "+N more" fragment for the rest.
 * The first fragment is kept whole however long it runs, and the scope tail always
 * survives: it is the only place the sentence says who the automation applies to.
 */
export function capFragments(
  fragments: readonly DescribeFragment[],
  t: Translate
): DescribeFragment[] {
  const kept: DescribeFragment[] = [];
  let length = 0;

  const last = fragments[fragments.length - 1];
  const scope = last?.nodeId === SENTENCE_SECTIONS.scope ? last : undefined;
  const body = scope ? fragments.slice(0, -1) : fragments;

  for (const fragment of body) {
    const next = kept.length === 0 ? fragment.text.length : length + 1 + fragment.text.length;
    if (kept.length > 0 && next > SENTENCE_LIMIT) break;
    kept.push(fragment);
    length = next;
  }

  const dropped = body.length - kept.length;
  if (dropped > 0) {
    kept.push({ nodeId: null, text: t('automations.describe.more', { count: dropped }) });
  }
  if (scope) kept.push(scope);

  return kept;
}

/** The capped fragments as one string. */
export function describeText(fragments: readonly DescribeFragment[], t: Translate): string {
  return capFragments(fragments, t)
    .map((fragment) => fragment.text)
    .join(' ');
}
