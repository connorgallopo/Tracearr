import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SLOT_KINDS,
  TEMPLATE_MIN_SERVER_VERSION,
  TEMPLATE_SCHEMA_VERSION,
  TemplateBindingError,
  fingerprintOf,
  liftAutomation,
  materializeTemplate,
  templateEnvelopeSchema,
  templateMinServerVersion,
} from '../index.js';
import * as entry from '../../index.js';
import type { TemplateSlot } from '../index.js';
import type {
  CreateAutomationInput,
  TemplateDefinition,
  TemplateEnvelope,
  TemplateInput,
} from '../../index.js';

const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const serverInput = { key: 'server', kind: 'server', label: 'Server', required: false };
const toInput = { key: 'to', kind: 'destinations', label: 'Send to', required: true };

const streamStarted = {
  kind: 'notification',
  triggers: [{ id: id(1), type: 'session.started', enabled: true }],
  conditions: { groups: [] },
  actions: {
    actions: [
      {
        id: id(2),
        type: 'send',
        to: { $input: 'to' },
        title: 'Stream started',
        body: '{{user.username}} started {{session.mediaTitle}}',
      },
    ],
  },
  scope: { serverId: { $input: 'server' } },
};

function envelope(patch: Record<string, unknown> = {}) {
  const inputs = [serverInput, toInput];
  return {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    slug: 'stream-started',
    name: 'Stream started',
    description: 'Notify a destination whenever playback begins',
    group: 'notifications',
    kind: 'notification',
    minServerVersion: TEMPLATE_MIN_SERVER_VERSION,
    inputs,
    definition: streamStarted,
    fingerprint: fingerprintOf({ inputs, definition: streamStarted }, sha256Hex),
    ...patch,
  };
}

const paths = (issues: { path: PropertyKey[] }[]) => issues.map((issue) => issue.path.join('.'));

describe('templateEnvelopeSchema', () => {
  it('round-trips a hand-written envelope', () => {
    const written = envelope();
    const parsed = templateEnvelopeSchema.parse(written);
    expect(parsed).toEqual(written);
  });

  it('rejects a placeholder naming no declared input', () => {
    const result = templateEnvelopeSchema.safeParse(
      envelope({
        definition: { ...streamStarted, scope: { serverId: { $input: 'nope' } } },
      })
    );
    expect(result.success).toBe(false);
    expect(paths(result.error?.issues ?? [])).toContain('definition.scope.serverId');
  });

  it('rejects an input nothing references', () => {
    const inputs = [
      serverInput,
      toInput,
      { key: 'spare', kind: 'text', label: 'Spare', required: false, default: 'x' },
    ];
    const result = templateEnvelopeSchema.safeParse(envelope({ inputs }));
    expect(result.success).toBe(false);
    expect(paths(result.error?.issues ?? [])).toContain('inputs.2.key');
  });

  it('rejects a default on a server input', () => {
    const result = templateEnvelopeSchema.safeParse(
      envelope({ inputs: [{ ...serverInput, default: id(3) }, toInput] })
    );
    expect(result.success).toBe(false);
  });

  it('rejects an optional destinations input', () => {
    const result = templateEnvelopeSchema.safeParse(
      envelope({ inputs: [serverInput, { ...toInput, required: false }] })
    );
    expect(result.success).toBe(false);
  });

  it('rejects an optional input with no default', () => {
    const inputs = [
      serverInput,
      toInput,
      { key: 'note', kind: 'text', label: 'Note', required: false },
    ];
    const result = templateEnvelopeSchema.safeParse(envelope({ inputs }));
    expect(result.success).toBe(false);
  });

  it('rejects a literal destination id but keeps node ids', () => {
    const definition = {
      ...streamStarted,
      actions: { actions: [{ id: id(2), type: 'send', to: [id(4)] }] },
    };
    const result = templateEnvelopeSchema.safeParse(
      envelope({ inputs: [serverInput], definition })
    );
    expect(result.success).toBe(false);
    expect(paths(result.error?.issues ?? [])).toContain('definition.actions.actions.0.to');
    expect(templateEnvelopeSchema.safeParse(envelope()).success).toBe(true);
  });

  it('rejects an envelope whose kind differs from its definition', () => {
    const result = templateEnvelopeSchema.safeParse(envelope({ kind: 'policy' }));
    expect(result.success).toBe(false);
    expect(paths(result.error?.issues ?? [])).toContain('kind');
  });

  it('rejects an input kind the slot cannot take', () => {
    const inputs = [serverInput, { ...toInput, kind: 'text', default: 'x', required: false }];
    const result = templateEnvelopeSchema.safeParse(envelope({ inputs }));
    expect(result.success).toBe(false);
  });
});

describe('materializeTemplate', () => {
  const version = () => {
    const parsed = templateEnvelopeSchema.parse(envelope());
    return { inputs: parsed.inputs, definition: parsed.definition };
  };

  it('drops an unbound optional scope and substitutes what is bound', () => {
    const result = materializeTemplate(version(), { to: [id(5)] }, { name: 'Stream started' });
    expect(result.name).toBe('Stream started');
    expect('serverId' in result).toBe(false);
    const [action] = result.actions.actions;
    expect(action).toMatchObject({ type: 'send', to: [id(5)] });
  });

  it('binds a scope input that is supplied', () => {
    const result = materializeTemplate(
      version(),
      { to: [id(5)], server: id(6) },
      { name: 'Stream started' }
    );
    expect(result.serverId).toBe(id(6));
  });

  it('throws with the keys a required input is missing', () => {
    const name = { name: 'Stream started' };
    expect(() => materializeTemplate(version(), {}, name)).toThrow(TemplateBindingError);
    try {
      materializeTemplate(version(), {}, name);
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateBindingError);
      expect((error as TemplateBindingError).missing).toEqual(['to']);
    }
  });

  it('converts an hours input into a minutes slot', () => {
    const inputs: TemplateInput[] = [
      { key: 'hold', kind: 'duration', unit: 'hours', label: 'Hold for', required: true },
    ];
    const definition: TemplateDefinition = {
      kind: 'notification',
      triggers: [
        {
          id: id(7),
          type: 'session.held_for',
          enabled: true,
          params: { minutes: { $input: 'hold' }, measure: 'current' },
        },
      ],
      conditions: { groups: [] },
      actions: { actions: [] },
      scope: {},
    };
    const result = materializeTemplate({ inputs, definition }, { hold: 2 }, { name: 'Held' });
    const [trigger] = result.triggers;
    expect(trigger).toMatchObject({ type: 'session.held_for', params: { minutes: 120 } });
  });
});

describe('liftAutomation', () => {
  it('turns scope ids, destinations and network values into required inputs', () => {
    const automation: CreateAutomationInput = {
      name: 'Kill VPN streams',
      kind: 'policy',
      severity: 'warning',
      triggers: [{ id: id(1), type: 'session.started', enabled: true }],
      conditions: {
        groups: [
          {
            id: id(8),
            conditions: [{ id: id(9), field: 'ip_in_range', operator: 'eq', value: '10.0.0.0/8' }],
          },
        ],
      },
      actions: { actions: [{ id: id(2), type: 'send', to: [id(4)] }] },
      serverId: id(6),
    };

    const { inputs, definition } = liftAutomation(automation);

    expect(inputs).toHaveLength(3);
    expect(inputs.every((input) => input.required)).toBe(true);
    expect(inputs.map((input) => input.kind).sort()).toEqual([
      'destinations',
      'field_value',
      'server',
    ]);
    expect(definition.scope.serverId).toEqual({ $input: 'server' });
    expect(definition.actions.actions[0]).toMatchObject({ to: { $input: 'to' } });
    expect(definition.conditions.groups[0]?.conditions[0]?.value).toEqual({ $input: 'ipInRange' });
    expect(definition.triggers).toEqual(automation.triggers);
  });

  it('gives each differing send list its own input', () => {
    const automation: CreateAutomationInput = {
      name: 'Two sends',
      kind: 'notification',
      severity: null,
      triggers: [{ id: id(1), type: 'session.started', enabled: true }],
      conditions: { groups: [] },
      actions: {
        actions: [
          { id: id(2), type: 'send', to: [id(4)] },
          { id: id(3), type: 'send', to: [id(5)] },
          { id: id(7), type: 'send', to: [id(4)] },
        ],
      },
    };

    const { inputs, definition } = liftAutomation(automation);

    expect(inputs.map((input) => input.key)).toEqual(['to', 'to2']);
    expect(definition.actions.actions.map((action) => ('to' in action ? action.to : null))).toEqual(
      [{ $input: 'to' }, { $input: 'to2' }, { $input: 'to' }]
    );
  });
});

describe('lift and materialize', () => {
  it('round-trips an automation through an envelope and back to its ids', () => {
    const automation: CreateAutomationInput = {
      name: 'Kill VPN streams',
      kind: 'policy',
      severity: 'warning',
      triggers: [{ id: id(1), type: 'session.started', enabled: true }],
      conditions: {
        groups: [
          {
            id: id(8),
            conditions: [{ id: id(9), field: 'ip_in_range', operator: 'eq', value: '10.0.0.0/8' }],
          },
        ],
      },
      actions: { actions: [{ id: id(2), type: 'send', to: [id(4)] }] },
      serverId: id(6),
    };

    const lifted = liftAutomation(automation);
    const parsed: TemplateEnvelope = templateEnvelopeSchema.parse({
      schemaVersion: TEMPLATE_SCHEMA_VERSION,
      slug: 'kill-vpn-streams',
      name: 'Kill VPN streams',
      description: 'Stop playback from a named network range',
      group: 'policies',
      kind: 'policy',
      minServerVersion: TEMPLATE_MIN_SERVER_VERSION,
      inputs: lifted.inputs,
      definition: lifted.definition,
      fingerprint: fingerprintOf(lifted, sha256Hex),
    });

    const rebuilt = materializeTemplate(
      { inputs: parsed.inputs, definition: parsed.definition },
      { server: id(6), to: [id(4)], ipInRange: '10.0.0.0/8' },
      { name: automation.name }
    );

    expect(rebuilt).toEqual(automation);
  });
});

describe('templateMinServerVersion', () => {
  const withTriggers = (...types: string[]) =>
    ({
      ...streamStarted,
      triggers: types.map((type, index) => ({ id: id(10 + index), type, enabled: true })),
    }) as TemplateDefinition;
  const resolutionCondition = (value: unknown) =>
    ({
      ...streamStarted,
      conditions: {
        groups: [
          {
            id: id(20),
            conditions: [{ id: id(21), field: 'source_resolution', operator: 'in', value }],
          },
        ],
      },
    }) as TemplateDefinition;
  const inputs = [serverInput, toInput] as TemplateInput[];

  it('is the floor for a definition that uses nothing newer', () => {
    expect(templateMinServerVersion({ inputs, definition: withTriggers('session.started') })).toBe(
      TEMPLATE_MIN_SERVER_VERSION
    );
  });

  it.each(['newsletter.failed', 'newsletter.sent', 'session.first_seen'])(
    'is 2.3.0 for the %s trigger',
    (type) => {
      expect(templateMinServerVersion({ inputs, definition: withTriggers(type) })).toBe('2.3.0');
    }
  );

  it('is 2.4.0 for a resolution value older servers rank as nothing', () => {
    expect(templateMinServerVersion({ inputs, definition: resolutionCondition(['4K']) })).toBe(
      TEMPLATE_MIN_SERVER_VERSION
    );
    expect(
      templateMinServerVersion({ inputs, definition: resolutionCondition(['4K', '1440p']) })
    ).toBe('2.4.0');
  });

  it('reads a placeholder through the default of the input it names', () => {
    const resolution = {
      key: 'resolution',
      kind: 'field_value',
      field: 'source_resolution',
      label: 'Resolution',
      required: true,
      default: ['8K'],
    } as TemplateInput;

    expect(
      templateMinServerVersion({
        inputs: [...inputs, resolution],
        definition: resolutionCondition({ $input: 'resolution' }),
      })
    ).toBe('2.4.0');
  });

  it('takes the highest when several apply', () => {
    const definition = {
      ...resolutionCondition(['8K']),
      triggers: withTriggers('session.started', 'session.first_seen').triggers,
    };

    expect(templateMinServerVersion({ inputs, definition })).toBe('2.4.0');
  });
});

const ENTRY_EXPORTS = [
  'TEMPLATE_GROUPS',
  'templateEnvelopeSchema',
  'TEMPLATE_SCHEMA_VERSION',
  'TEMPLATE_MIN_SERVER_VERSION',
  'templateMinServerVersion',
  'canonicalJson',
  'fingerprintOf',
  'materializeTemplate',
  'slotValueFor',
  'liftAutomation',
  'encodeShareCode',
  'decodeShareCode',
  'ShareCodeError',
  'TemplateBindingError',
];

describe('package entry', () => {
  it('reaches every template and share primitive a consumer uses', () => {
    expect(ENTRY_EXPORTS.filter((name) => !(name in entry))).toEqual([]);
    const destinations: TemplateSlot = 'to';
    expect(SLOT_KINDS[destinations]).toEqual(['destinations']);
  });
});

describe('fingerprintOf', () => {
  it('is stable across key order', () => {
    const inputs = [serverInput, toInput];
    const first = fingerprintOf({ inputs, definition: streamStarted }, sha256Hex);
    const reordered = {
      scope: streamStarted.scope,
      actions: streamStarted.actions,
      conditions: streamStarted.conditions,
      triggers: streamStarted.triggers,
      kind: streamStarted.kind,
    };
    const second = fingerprintOf({ definition: reordered, inputs }, sha256Hex);
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});
