import { z } from 'zod';
import { compareVersions } from '../releaseVersion.js';
import { CONDITION_FIELD_LABELS } from '../violations.js';
import {
  ifActionSchema,
  killStreamActionSchema,
  messageClientActionSchema,
  automationActionsSchema,
  sendActionSchema,
  trustActionSchema,
} from './actions.js';
import {
  CONDITION_FIELDS,
  CONDITION_VALUE_INTRODUCED_IN,
  conditionFieldSchema,
  conditionGroupSchema,
  conditionSchema,
  conditionValueSchema,
  automationConditionsSchema,
} from './conditions.js';
import { createAutomationSchema } from './definition.js';
import { TRIGGER_INTRODUCED_IN, triggerNodeSchema } from './triggers.js';
import type { Action, LeafAction } from './actions.js';
import type {
  Condition,
  ConditionField,
  ConditionGroup,
  ConditionValueType,
  AutomationConditions,
} from './conditions.js';
import type { CreateAutomationInput } from './definition.js';

const placeholder = z.strictObject({ $input: z.string().min(1).max(64) });

/** A value slot holds either the literal an automation would carry or a placeholder naming an input. */
const slot = <T extends z.ZodType>(schema: T) => z.union([placeholder, schema]);

/** The same for a slot the definition may leave out, keeping the source schema's own type. */
const optionalSlot = <T extends z.ZodType>(schema: z.ZodOptional<T>) =>
  slot(schema.unwrap()).optional();

export const TEMPLATE_GROUPS = [
  'notifications',
  'server_health',
  'policies',
  'housekeeping',
] as const;
export const TEMPLATE_SCHEMA_VERSION = 1;
/** The release templates shipped in, and the least any template needs. */
export const TEMPLATE_MIN_SERVER_VERSION = '2.2.0';

const inputBase = {
  key: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9]*$/)
    .max(32),
  label: z.string().max(80),
  description: z.string().max(300).optional(),
  required: z.boolean(),
};

export const templateInputSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ ...inputBase, kind: z.literal('server') }),
    z.strictObject({ ...inputBase, kind: z.literal('account') }),
    z.strictObject({ ...inputBase, kind: z.literal('person') }),
    z.strictObject({ ...inputBase, kind: z.literal('destinations'), required: z.literal(true) }),
    z.strictObject({
      ...inputBase,
      kind: z.literal('field_value'),
      field: conditionFieldSchema,
      default: conditionValueSchema.optional(),
    }),
    z.strictObject({
      ...inputBase,
      kind: z.literal('number'),
      min: z.number().optional(),
      max: z.number().optional(),
      unit: z.string().max(16).optional(),
      step: z.number().optional(),
      default: z.number().optional(),
    }),
    z.strictObject({
      ...inputBase,
      kind: z.literal('duration'),
      unit: z.enum(['minutes', 'hours', 'days']),
      min: z.number().optional(),
      max: z.number().optional(),
      default: z.number().optional(),
    }),
    z.strictObject({
      ...inputBase,
      kind: z.literal('text'),
      maxLength: z.number().int().max(2000).optional(),
      default: z.string().optional(),
    }),
    z.strictObject({ ...inputBase, kind: z.literal('boolean'), default: z.boolean().optional() }),
    z.strictObject({
      ...inputBase,
      kind: z.literal('select'),
      options: z.array(z.strictObject({ value: z.string(), label: z.string() })).min(1),
      multiple: z.boolean().optional(),
      default: z.union([z.string(), z.array(z.string())]).optional(),
    }),
  ])
  .superRefine((input, ctx) => {
    if (
      !input.required &&
      !['server', 'account', 'person'].includes(input.kind) &&
      !('default' in input && input.default !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: 'optional inputs need a default',
      });
    }
  });
export type TemplateInput = z.infer<typeof templateInputSchema>;
type TemplateInputKind = TemplateInput['kind'];

/** Which input kinds each value slot accepts; condition values go by field instead. */
export const SLOT_KINDS = {
  to: ['destinations'],
  serverId: ['server'],
  serverUserId: ['account'],
  userId: ['person'],
  minutes: ['duration', 'number'],
  days: ['duration', 'number'],
  window_hours: ['duration', 'number'],
  enabled: ['boolean'],
  exclude_same_device: ['boolean'],
  exclude_same_ip: ['boolean'],
  message: ['text'],
  title: ['text'],
  body: ['text'],
  amount: ['number', 'duration'],
  value: ['number', 'duration'],
  delay_seconds: ['number', 'duration'],
  cooldown_minutes: ['number', 'duration'],
} as const satisfies Record<string, readonly TemplateInputKind[]>;

export type TemplateSlot = keyof typeof SLOT_KINDS;
const isSlot = (key: string): key is TemplateSlot => key in SLOT_KINDS;

/** A condition value takes an input for its own field, or a scalar input of the matching type. */
const VALUE_TYPE_KINDS = {
  number: ['number'],
  boolean: ['boolean'],
  text: ['text'],
  select: ['select'],
  multiSelect: ['select'],
  cidr: ['text'],
} as const satisfies Record<ConditionValueType, readonly TemplateInputKind[]>;

type DurationUnit = 'minutes' | 'hours' | 'days';
type SlotUnit = DurationUnit | 'seconds';

/** What a duration slot stores; a duration input converts from its own unit into this one. */
const SLOT_UNITS: Partial<Record<TemplateSlot, SlotUnit>> = {
  minutes: 'minutes',
  days: 'days',
  window_hours: 'hours',
  cooldown_minutes: 'minutes',
  delay_seconds: 'seconds',
};

const MINUTES_PER: Record<DurationUnit, number> = { minutes: 1, hours: 60, days: 1440 };

function convertDuration(value: number, from: DurationUnit, to: SlotUnit): number {
  const minutes = value * MINUTES_PER[from];
  switch (to) {
    case 'seconds':
      return minutes * 60;
    case 'minutes':
      return minutes;
    case 'hours':
      return Math.ceil(minutes / 60);
    case 'days':
      return Math.ceil(minutes / 1440);
  }
}

const nodeEnabledSlot = optionalSlot(conditionSchema.shape.enabled);
const conditionParamsSchema = conditionSchema.shape.params.unwrap();

const templateConditionSchema = conditionSchema.extend({
  enabled: nodeEnabledSlot,
  value: slot(conditionSchema.shape.value),
  params: conditionParamsSchema
    .extend({
      window_hours: optionalSlot(conditionParamsSchema.shape.window_hours),
      exclude_same_device: optionalSlot(conditionParamsSchema.shape.exclude_same_device),
      exclude_same_ip: optionalSlot(conditionParamsSchema.shape.exclude_same_ip),
    })
    .optional(),
});
type TemplateCondition = z.infer<typeof templateConditionSchema>;

const templateConditionGroupSchema = conditionGroupSchema.extend({
  enabled: nodeEnabledSlot,
  conditions: z.array(templateConditionSchema).min(1),
});
type TemplateConditionGroup = z.infer<typeof templateConditionGroupSchema>;

const templateConditionsSchema = automationConditionsSchema.extend({
  groups: z.array(templateConditionGroupSchema),
});
type TemplateConditions = z.infer<typeof templateConditionsSchema>;

// The trigger union's members in declaration order: paramless, session.held_for, account.inactive_for.
const [paramlessTrigger, heldForTrigger, inactiveForTrigger] = triggerNodeSchema.options;
const triggerEnabledSlot = slot(paramlessTrigger.shape.enabled);

const templateTriggerNodeSchema = z.discriminatedUnion('type', [
  paramlessTrigger.extend({ enabled: triggerEnabledSlot }),
  heldForTrigger.extend({
    enabled: triggerEnabledSlot,
    params: heldForTrigger.shape.params.extend({
      minutes: slot(heldForTrigger.shape.params.shape.minutes),
    }),
  }),
  inactiveForTrigger.extend({
    enabled: triggerEnabledSlot,
    params: inactiveForTrigger.shape.params.extend({
      days: slot(inactiveForTrigger.shape.params.shape.days),
    }),
  }),
]);

const templateSendActionSchema = sendActionSchema.extend({
  enabled: nodeEnabledSlot,
  to: slot(sendActionSchema.shape.to),
  title: optionalSlot(sendActionSchema.shape.title),
  body: optionalSlot(sendActionSchema.shape.body),
  cooldown_minutes: optionalSlot(sendActionSchema.shape.cooldown_minutes),
});

// Rebuilt from the shape rather than extended: zod will not overwrite keys on a
// refined schema, and trust's mode/amount/value checks run again at materialize.
const templateTrustActionSchema = z.object({
  ...trustActionSchema.shape,
  enabled: nodeEnabledSlot,
  amount: optionalSlot(trustActionSchema.shape.amount),
  value: optionalSlot(trustActionSchema.shape.value),
  cooldown_minutes: optionalSlot(trustActionSchema.shape.cooldown_minutes),
});

const templateKillStreamActionSchema = killStreamActionSchema.extend({
  enabled: nodeEnabledSlot,
  delay_seconds: optionalSlot(killStreamActionSchema.shape.delay_seconds),
  cooldown_minutes: optionalSlot(killStreamActionSchema.shape.cooldown_minutes),
  message: optionalSlot(killStreamActionSchema.shape.message),
});

const templateMessageClientActionSchema = messageClientActionSchema.extend({
  enabled: nodeEnabledSlot,
  message: slot(messageClientActionSchema.shape.message),
});

const templateLeafActionSchema = z.discriminatedUnion('type', [
  templateSendActionSchema,
  templateTrustActionSchema,
  templateKillStreamActionSchema,
  templateMessageClientActionSchema,
]);
type TemplateLeafAction = z.infer<typeof templateLeafActionSchema>;

const templateIfActionSchema = ifActionSchema.extend({
  enabled: nodeEnabledSlot,
  conditions: templateConditionsSchema,
  then: z.array(templateLeafActionSchema),
  else: z.array(templateLeafActionSchema),
});

const templateActionSchema = z.discriminatedUnion('type', [
  templateSendActionSchema,
  templateTrustActionSchema,
  templateKillStreamActionSchema,
  templateMessageClientActionSchema,
  templateIfActionSchema,
]);
type TemplateAction = z.infer<typeof templateActionSchema>;

const templateActionsSchema = automationActionsSchema.extend({
  actions: z.array(templateActionSchema),
});

export const templateDefinitionSchema = z.strictObject({
  kind: createAutomationSchema.shape.kind,
  severity: createAutomationSchema.shape.severity.optional(),
  triggers: z.array(templateTriggerNodeSchema),
  conditions: templateConditionsSchema,
  actions: templateActionsSchema,
  scope: z.strictObject({
    serverId: slot(z.uuid()).optional(),
    serverUserId: slot(z.uuid()).optional(),
    userId: slot(z.uuid()).optional(),
  }),
  enforceAcrossServers: createAutomationSchema.shape.enforceAcrossServers,
  cooldownMinutes: createAutomationSchema.shape.cooldownMinutes,
});
export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;

interface SlotVisit {
  slot: TemplateSlot;
  value: unknown;
  path: (string | number)[];
  /** Set for a condition value, whose acceptable kinds come from the field. */
  field?: ConditionField;
}

/** Every value slot the definition fills, with the path an issue would report. */
function slotsOf(definition: TemplateDefinition): SlotVisit[] {
  const visits: SlotVisit[] = [];
  const add = (
    name: TemplateSlot,
    value: unknown,
    path: (string | number)[],
    field?: ConditionField
  ) => {
    if (value !== undefined) visits.push({ slot: name, value, path, field });
  };
  const addKeys = (node: Record<string, unknown>, path: (string | number)[]) => {
    for (const [key, value] of Object.entries(node)) {
      if (isSlot(key)) add(key, value, [...path, key]);
    }
  };
  const addParams = (params: Record<string, unknown> | undefined, path: (string | number)[]) => {
    if (params) addKeys(params, [...path, 'params']);
  };
  const addCondition = (condition: TemplateCondition, path: (string | number)[]) => {
    add('enabled', condition.enabled, [...path, 'enabled']);
    add('value', condition.value, [...path, 'value'], condition.field);
    addParams(condition.params, path);
  };
  const addConditions = (conditions: TemplateConditions, path: (string | number)[]) => {
    conditions.groups.forEach((group, groupIndex) => {
      const groupPath = [...path, 'groups', groupIndex];
      add('enabled', group.enabled, [...groupPath, 'enabled']);
      group.conditions.forEach((condition, index) =>
        addCondition(condition, [...groupPath, 'conditions', index])
      );
    });
  };

  addKeys(definition.scope, ['definition', 'scope']);
  definition.triggers.forEach((trigger, index) => {
    const path = ['definition', 'triggers', index];
    add('enabled', trigger.enabled, [...path, 'enabled']);
    if ('params' in trigger) addParams(trigger.params, path);
  });
  addConditions(definition.conditions, ['definition', 'conditions']);
  definition.actions.actions.forEach((action, index) => {
    const path = ['definition', 'actions', 'actions', index];
    addKeys(action, path);
    if (action.type !== 'if') return;
    addConditions(action.conditions, [...path, 'conditions']);
    action.then.forEach((leaf, leafIndex) => addKeys(leaf, [...path, 'then', leafIndex]));
    action.else.forEach((leaf, leafIndex) => addKeys(leaf, [...path, 'else', leafIndex]));
  });
  return visits;
}

const placeholderKey = (value: unknown): string | undefined => {
  const parsed = placeholder.safeParse(value);
  return parsed.success ? parsed.data.$input : undefined;
};

// Slots that name something on this install: exporting the literal would leak it.
const ID_FREE_SLOTS = new Set<TemplateSlot>(['serverId', 'serverUserId', 'userId', 'to']);
const ID_FREE_FIELDS = new Set<ConditionField>(['server_id', 'user_id', 'ip_in_range']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const holdsId = (value: unknown): boolean =>
  typeof value === 'string'
    ? UUID_PATTERN.test(value)
    : Array.isArray(value) && value.some(holdsId);

function kindsFor(visit: SlotVisit): readonly TemplateInputKind[] {
  if (visit.field) {
    return ['field_value', ...VALUE_TYPE_KINDS[CONDITION_FIELDS[visit.field].valueType]];
  }
  return SLOT_KINDS[visit.slot];
}

const envelopeFieldsSchema = z.strictObject({
  schemaVersion: z.literal(TEMPLATE_SCHEMA_VERSION),
  slug: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300),
  group: z.enum(TEMPLATE_GROUPS),
  kind: createAutomationSchema.shape.kind,
  author: z.string().max(80).optional(),
  minServerVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  inputs: z.array(templateInputSchema),
  definition: templateDefinitionSchema,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});

function checkIntegrity(
  envelope: z.infer<typeof envelopeFieldsSchema>,
  ctx: z.RefinementCtx
): void {
  if (envelope.kind !== envelope.definition.kind) {
    ctx.addIssue({
      code: 'custom',
      path: ['kind'],
      message: 'the envelope and its definition disagree on kind',
    });
  }
  const byKey = new Map(envelope.inputs.map((input) => [input.key, input]));
  const used = new Set<string>();
  for (const visit of slotsOf(envelope.definition)) {
    const key = placeholderKey(visit.value);
    if (key === undefined) {
      const forbidsIds = visit.field
        ? ID_FREE_FIELDS.has(visit.field)
        : ID_FREE_SLOTS.has(visit.slot);
      if (forbidsIds && holdsId(visit.value)) {
        ctx.addIssue({
          code: 'custom',
          path: visit.path,
          message: `${visit.slot} names an id from one install; it needs an input`,
        });
      }
      continue;
    }
    used.add(key);
    const input = byKey.get(key);
    if (!input) {
      ctx.addIssue({ code: 'custom', path: visit.path, message: `no input named ${key}` });
      continue;
    }
    if (!kindsFor(visit).includes(input.kind)) {
      ctx.addIssue({
        code: 'custom',
        path: visit.path,
        message: `a ${input.kind} input does not fit ${visit.slot}`,
      });
    } else if (input.kind === 'field_value' && visit.field && input.field !== visit.field) {
      ctx.addIssue({
        code: 'custom',
        path: visit.path,
        message: `${key} holds a ${input.field} value, not ${visit.field}`,
      });
    }
  }
  envelope.inputs.forEach((input, index) => {
    if (!used.has(input.key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['inputs', index, 'key'],
        message: `${input.key} is never used`,
      });
    }
  });
}

/**
 * The oldest server release that runs the template as written: the newest release
 * among the triggers and condition values it uses, never below the floor. A
 * placeholder counts through its input's default, which an import prefills.
 */
export function templateMinServerVersion(template: {
  inputs: TemplateInput[];
  definition: TemplateDefinition;
}): string {
  const byKey = new Map(template.inputs.map((input) => [input.key, input]));
  const needed = template.definition.triggers.map((trigger) => TRIGGER_INTRODUCED_IN[trigger.type]);

  for (const visit of slotsOf(template.definition)) {
    const introducedIn = visit.field && CONDITION_VALUE_INTRODUCED_IN[visit.field];
    if (!introducedIn) continue;
    const key = placeholderKey(visit.value);
    const input = key === undefined ? undefined : byKey.get(key);
    const value = key === undefined ? visit.value : input && 'default' in input && input.default;
    for (const entry of [value].flat()) {
      if (typeof entry === 'string') needed.push(introducedIn[entry]);
    }
  }

  return needed.reduce<string>(
    (highest, version) =>
      version !== undefined && compareVersions(version, highest) > 0 ? version : highest,
    TEMPLATE_MIN_SERVER_VERSION
  );
}

export const templateEnvelopeSchema = envelopeFieldsSchema.superRefine(checkIntegrity);
export type TemplateEnvelope = z.infer<typeof templateEnvelopeSchema>;

export class TemplateBindingError extends Error {
  constructor(readonly missing: string[]) {
    super(`unbound required inputs: ${missing.join(', ')}`);
    this.name = 'TemplateBindingError';
  }
}

/** An optional input left unbound; the key it sits under drops out of the definition. */
const DROP = Symbol('unbound');

/** What a bound input lands as in a slot: a duration converts into the unit that slot stores. */
export function slotValueFor(input: TemplateInput, value: unknown, slotName: string): unknown {
  if (input.kind !== 'duration' || typeof value !== 'number') return value;
  const unit = isSlot(slotName) ? SLOT_UNITS[slotName] : undefined;
  return unit ? convertDuration(value, input.unit, unit) : value;
}

export function materializeTemplate(
  version: { inputs: TemplateInput[]; definition: TemplateDefinition },
  bound: Record<string, unknown>,
  options: { name: string }
): CreateAutomationInput {
  const resolved = new Map<string, { input: TemplateInput; value: unknown }>();
  const missing: string[] = [];
  for (const input of version.inputs) {
    const value = bound[input.key] ?? ('default' in input ? input.default : undefined);
    if (value === undefined) {
      if (input.required) missing.push(input.key);
      continue;
    }
    resolved.set(input.key, { input, value });
  }
  if (missing.length > 0) throw new TemplateBindingError(missing);

  const substitute = (node: unknown, slotName: string): unknown => {
    const key = placeholderKey(node);
    if (key !== undefined) {
      const binding = resolved.get(key);
      return binding ? slotValueFor(binding.input, binding.value, slotName) : DROP;
    }
    if (Array.isArray(node)) {
      return node.map((item) => substitute(item, slotName)).filter((item) => item !== DROP);
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
        const value = substitute(child, childKey);
        if (value !== DROP) out[childKey] = value;
      }
      return out;
    }
    return node;
  };

  const { definition } = version;
  const scope: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(definition.scope)) {
    const bindingValue = substitute(value, key);
    if (bindingValue !== DROP && bindingValue !== undefined) scope[key] = bindingValue;
  }
  return createAutomationSchema.parse({
    name: options.name,
    kind: definition.kind,
    severity: definition.severity ?? null,
    triggers: substitute(definition.triggers, 'triggers'),
    conditions: substitute(definition.conditions, 'conditions'),
    actions: substitute(definition.actions, 'actions'),
    enforceAcrossServers: definition.enforceAcrossServers,
    cooldownMinutes: definition.cooldownMinutes,
    ...scope,
  });
}

const camelCase = (field: ConditionField) =>
  field.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

/** Strips this install's ids and destinations out of a definition, declaring an input for each. */
export function liftAutomation(automation: CreateAutomationInput): {
  inputs: TemplateInput[];
  definition: TemplateDefinition;
} {
  const inputs: TemplateInput[] = [];
  const claimed = new Map<string, string>();

  const claim = (base: string, value: unknown, make: (key: string) => TemplateInput) => {
    const signature = `${base}:${JSON.stringify(value)}`;
    const existing = claimed.get(signature);
    if (existing !== undefined) return { $input: existing };
    const taken = [...claimed.keys()].filter((seen) => seen.startsWith(`${base}:`)).length;
    const key = taken === 0 ? base : `${base}${taken + 1}`;
    claimed.set(signature, key);
    inputs.push(make(key));
    return { $input: key };
  };

  const claimScope = (id: string, kind: 'server' | 'account' | 'person', label: string) =>
    claim(kind, id, (key) => ({ key, kind, label, required: true }));

  const liftCondition = (condition: Condition): TemplateCondition => {
    if (!ID_FREE_FIELDS.has(condition.field)) return condition;
    const { field } = condition;
    return {
      ...condition,
      value: claim(camelCase(field), condition.value, (key) => ({
        key,
        kind: 'field_value',
        field,
        label: CONDITION_FIELD_LABELS[field],
        required: true,
      })),
    };
  };
  const liftGroup = (group: ConditionGroup): TemplateConditionGroup => ({
    ...group,
    conditions: group.conditions.map(liftCondition),
  });
  const liftConditions = (conditions: AutomationConditions): TemplateConditions => ({
    ...conditions,
    groups: conditions.groups.map(liftGroup),
  });
  const liftLeaf = (action: LeafAction): TemplateLeafAction =>
    action.type === 'send'
      ? {
          ...action,
          to: claim('to', action.to, (key) => ({
            key,
            kind: 'destinations',
            label: 'Send to',
            required: true,
          })),
        }
      : action;
  const liftAction = (action: Action): TemplateAction =>
    action.type === 'if'
      ? {
          ...action,
          conditions: liftConditions(action.conditions),
          then: action.then.map(liftLeaf),
          else: action.else.map(liftLeaf),
        }
      : liftLeaf(action);

  const scope: TemplateDefinition['scope'] = {};
  if (automation.serverId) scope.serverId = claimScope(automation.serverId, 'server', 'Server');
  if (automation.serverUserId) {
    scope.serverUserId = claimScope(automation.serverUserId, 'account', 'Account');
  }
  if (automation.userId) scope.userId = claimScope(automation.userId, 'person', 'Person');

  return {
    inputs,
    definition: {
      kind: automation.kind,
      severity: automation.severity,
      triggers: automation.triggers,
      conditions: liftConditions(automation.conditions),
      actions: { actions: automation.actions.actions.map(liftAction) },
      scope,
      enforceAcrossServers: automation.enforceAcrossServers,
      cooldownMinutes: automation.cooldownMinutes,
    },
  };
}
