import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_KINDS,
  automationDefinitionSchema,
  createAutomationSchema,
  updateAutomationSchema,
  TRIGGERS,
  TRIGGER_TYPES,
  CONDITION_FIELDS,
  ACTIONS,
  triggerNodeSchema,
  contextOf,
  fieldsAvailableFor,
  variablesFor,
} from '../index.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const started = { id: id(1), type: 'session.started', enabled: true } as const;
const down = { id: id(2), type: 'server.down', enabled: true } as const;
const held = {
  id: id(3),
  type: 'session.held_for',
  enabled: true,
  params: { minutes: 30, measure: 'current' },
} as const;
const mediaAdded = { id: id(4), type: 'media.added', enabled: true } as const;
const mediaUpgraded = { id: id(5), type: 'media.upgraded', enabled: true } as const;
const newDevice = { id: id(6), type: 'account.new_device', enabled: true } as const;
const trustChanged = { id: id(7), type: 'account.trust_changed', enabled: true } as const;
const base = {
  name: 'x',
  kind: 'notification',
  severity: null,
  conditions: { groups: [] },
  actions: { actions: [] },
};

describe('catalog', () => {
  it('has sixteen triggers with a context and a group', () => {
    expect(TRIGGER_TYPES).toHaveLength(16);
    for (const t of TRIGGER_TYPES)
      expect(TRIGGERS[t].context).toMatch(/session|account|media|server|install/);
    expect(TRIGGERS['server.down'].context).toBe('server');
    expect(TRIGGERS['tracearr.update_available'].context).toBe('install');
    expect(TRIGGERS['media.added'].context).toBe('media');
    expect(TRIGGERS['media.upgraded'].group).toBe('library');
    // The group is picker taxonomy; a new device arrives on a session and carries one.
    expect(TRIGGERS['account.new_device'].context).toBe('session');
    expect(TRIGGERS['account.new_device'].group).toBe('accounts');
    expect(TRIGGERS['account.trust_changed'].context).toBe('account');
    expect(TRIGGERS['account.trust_changed'].group).toBe('accounts');
  });
  it('has 31 condition fields each with requires and operators', () => {
    expect(Object.keys(CONDITION_FIELDS)).toHaveLength(31);
    expect(CONDITION_FIELDS.server_id.requires).toBe('server');
    expect(CONDITION_FIELDS.inactive_days.requires).toBe('account');
    expect(CONDITION_FIELDS.is_transcoding.requires).toBe('session');
    expect(CONDITION_FIELDS.concurrent_streams.operators).toContain('gt');
  });
  it('groups every action and names the context it needs', () => {
    expect(ACTIONS.trust.requires).toBe('account');
    expect(ACTIONS.kill_stream.group).toBe('policy');
  });
  it('types trigger params', () => {
    expect(triggerNodeSchema.safeParse(held).success).toBe(true);
    expect(
      triggerNodeSchema.safeParse({ ...held, params: { minutes: 0, measure: 'current' } }).success
    ).toBe(false);
    expect(
      triggerNodeSchema.safeParse({ id: id(4), type: 'session.held_for', enabled: true }).success
    ).toBe(false);
    expect(
      triggerNodeSchema.safeParse({
        id: id(5),
        type: 'account.inactive_for',
        enabled: true,
        params: { days: 30 },
      }).success
    ).toBe(true);
  });
});

describe('definition refinements', () => {
  it('rejects a condition field the triggers cannot supply', () => {
    const def = {
      ...base,
      triggers: [down],
      conditions: {
        groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: 'video' }] }],
      },
    };
    const r = automationDefinitionSchema.safeParse(def);
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0]?.path.join('.')).toBe(
      'conditions.groups.0.conditions.0.field'
    );
  });
  it('allows server_id for server triggers and nothing for install triggers', () => {
    expect(fieldsAvailableFor('server')).toEqual(['server_id']);
    expect(fieldsAvailableFor('install')).toEqual([]);
    expect(contextOf([started, down])).toBe('server');
    expect(contextOf([])).toBeNull();
  });
  it('rejects operators a field does not offer and mismatched value shapes', () => {
    const bad = {
      ...base,
      triggers: [started],
      conditions: {
        groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'contains', value: 3 }] }],
      },
    };
    expect(automationDefinitionSchema.safeParse(bad).success).toBe(false);
    const badValue = {
      ...base,
      triggers: [started],
      conditions: {
        groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 'three' }] }],
      },
    };
    expect(automationDefinitionSchema.safeParse(badValue).success).toBe(false);
  });
  it('takes a single value for is on a list field and rejects a list there', () => {
    const withCountry = (operator: string, value: unknown) => ({
      ...base,
      triggers: [started],
      conditions: { groups: [{ conditions: [{ field: 'country', operator, value }] }] },
    });
    expect(automationDefinitionSchema.safeParse(withCountry('eq', 'US')).success).toBe(true);
    expect(automationDefinitionSchema.safeParse(withCountry('neq', 'US')).success).toBe(true);
    expect(automationDefinitionSchema.safeParse(withCountry('in', ['US'])).success).toBe(true);
    expect(automationDefinitionSchema.safeParse(withCountry('eq', ['US'])).success).toBe(false);
  });
  it('accepts if with leaf branches and rejects nested if', () => {
    const leaf = { type: 'message_client', message: 'hi' };
    const ok = {
      ...base,
      triggers: [started],
      actions: { actions: [{ type: 'if', conditions: { groups: [] }, then: [leaf], else: [] }] },
    };
    expect(automationDefinitionSchema.safeParse(ok).success).toBe(true);
    const nested = {
      ...base,
      triggers: [started],
      actions: {
        actions: [
          {
            type: 'if',
            conditions: { groups: [] },
            then: [{ type: 'if', conditions: { groups: [] }, then: [], else: [] }],
            else: [],
          },
        ],
      },
    };
    expect(automationDefinitionSchema.safeParse(nested).success).toBe(false);
  });
  it('validates send variables against the intersection of trigger variables', () => {
    const send = (body: string) => ({ type: 'send', to: [id(9)], body });
    expect(
      automationDefinitionSchema.safeParse({
        ...base,
        triggers: [started],
        actions: { actions: [send('{{user.username}} on {{server.name}}')] },
      }).success
    ).toBe(true);
    expect(
      automationDefinitionSchema.safeParse({
        ...base,
        triggers: [started, down],
        actions: { actions: [send('{{user.username}}')] },
      }).success
    ).toBe(false);
    const badTitle = automationDefinitionSchema.safeParse({
      ...base,
      triggers: [started, down],
      actions: { actions: [{ type: 'send', to: [id(9)], title: '{{user.username}}' }] },
    });
    expect(badTitle.success ? '' : badTitle.error.issues[0]?.path.join('.')).toBe(
      'actions.actions.0.title'
    );
    expect(variablesFor([started, down])).toContain('server.name');
    expect(variablesFor([started, down])).not.toContain('user.username');
  });

  it('validates send variables inside if branches', () => {
    const branch = {
      type: 'if',
      conditions: { groups: [] },
      then: [{ type: 'send', to: [id(9)], body: '{{user.username}}' }],
      else: [],
    };
    const r = automationDefinitionSchema.safeParse({
      ...base,
      triggers: [started, down],
      actions: { actions: [branch] },
    });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0]?.path.join('.')).toBe(
      'actions.actions.0.then.0.body'
    );
  });
  it('requires account context for trust and session context for kill/message', () => {
    expect(
      automationDefinitionSchema.safeParse({
        ...base,
        triggers: [down],
        actions: { actions: [{ type: 'trust', mode: 'reset' }] },
      }).success
    ).toBe(false);
    expect(
      automationDefinitionSchema.safeParse({
        ...base,
        triggers: [down],
        actions: { actions: [{ type: 'kill_stream' }] },
      }).success
    ).toBe(false);
  });
  it('restricts policy kind to session/account triggers', () => {
    expect(
      automationDefinitionSchema.safeParse({
        ...base,
        kind: 'policy',
        severity: 'warning',
        triggers: [down],
      }).success
    ).toBe(false);
    expect(
      automationDefinitionSchema.safeParse({
        ...base,
        kind: 'policy',
        severity: 'warning',
        triggers: [started],
      }).success
    ).toBe(true);
  });
  it('rejects a session condition on a media trigger', () => {
    const def = {
      ...base,
      triggers: [mediaAdded],
      conditions: {
        groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gte', value: 2 }] }],
      },
    };
    const r = automationDefinitionSchema.safeParse(def);
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0]?.path.join('.')).toBe(
      'conditions.groups.0.conditions.0.field'
    );
  });
  it('keeps a media trigger off a policy, which is about a user', () => {
    const r = automationDefinitionSchema.safeParse({
      ...base,
      kind: 'policy',
      severity: 'warning',
      triggers: [mediaAdded],
    });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0]?.path.join('.')).toBe('triggers');
  });
  it('offers the media variables to a send and nothing about a user', () => {
    const send = (body: string) => ({ type: 'send', to: [id(9)], body });
    expect(
      automationDefinitionSchema.safeParse({
        ...base,
        triggers: [mediaUpgraded],
        actions: { actions: [send('{{media.title}}: {{media.to.resolution}}')] },
      }).success
    ).toBe(true);
    expect(
      automationDefinitionSchema.safeParse({
        ...base,
        triggers: [mediaUpgraded],
        actions: { actions: [send('{{user.username}}')] },
      }).success
    ).toBe(false);
    expect(
      automationDefinitionSchema.safeParse({
        ...base,
        triggers: [mediaAdded],
        actions: { actions: [send('{{media.to.resolution}}')] },
      }).success
    ).toBe(false);
  });
  it('accepts match on groups and defaults it to any for legacy rows', () => {
    const grp = {
      match: 'all',
      conditions: [{ field: 'trust_score', operator: 'lt', value: 50 }],
    };
    const parsed = automationDefinitionSchema.safeParse({
      ...base,
      triggers: [started],
      conditions: { groups: [grp] },
    });
    expect(parsed.success).toBe(true);
    const legacy = automationDefinitionSchema.parse({
      ...base,
      triggers: [started],
      conditions: { groups: [{ conditions: grp.conditions }] },
    });
    expect(legacy.conditions.groups[0]?.match).toBeUndefined();
  });
  it('takes empty condition groups on the definition and on an if node', () => {
    expect(createAutomationSchema.safeParse({ ...base, triggers: [started] }).success).toBe(true);
    expect(
      automationDefinitionSchema.safeParse({
        ...base,
        triggers: [started],
        actions: { actions: [{ type: 'if', conditions: { groups: [] }, then: [], else: [] }] },
      }).success
    ).toBe(true);
  });
  it('needs a trigger, and an enabled one', () => {
    expect(automationDefinitionSchema.safeParse(base).success).toBe(false);
    expect(
      automationDefinitionSchema.safeParse({ ...base, triggers: [{ ...started, enabled: false }] })
        .success
    ).toBe(false);
  });

  it.each([[newDevice], [trustChanged]])('keeps %o off a policy and takes it on a send', (node) => {
    const policy = automationDefinitionSchema.safeParse({
      ...base,
      kind: 'policy',
      severity: 'warning',
      triggers: [node],
    });
    expect(policy.success).toBe(false);
    expect(policy.success ? '' : policy.error.issues[0]?.path.join('.')).toBe('triggers');
    expect(automationDefinitionSchema.safeParse({ ...base, triggers: [node] }).success).toBe(true);
  });

  it('refuses a trust action beside a trust trigger, branches included', () => {
    const trust = { type: 'trust', mode: 'adjust', amount: -5 };
    const flat = automationDefinitionSchema.safeParse({
      ...base,
      triggers: [trustChanged],
      actions: { actions: [trust] },
    });
    expect(flat.success).toBe(false);
    expect(flat.success ? '' : flat.error.issues[0]?.path.join('.')).toBe('actions.actions.0.type');

    const branched = automationDefinitionSchema.safeParse({
      ...base,
      triggers: [trustChanged],
      actions: { actions: [{ type: 'if', conditions: { groups: [] }, then: [trust], else: [] }] },
    });
    expect(branched.success).toBe(false);
    expect(branched.success ? '' : branched.error.issues[0]?.path.join('.')).toBe(
      'actions.actions.0.then.0.type'
    );

    expect(
      automationDefinitionSchema.safeParse({
        ...base,
        triggers: [started],
        actions: { actions: [trust] },
      }).success
    ).toBe(true);
  });

  it('offers a trust trigger its account fields and a device trigger the session ones', () => {
    expect(fieldsAvailableFor(contextOf([trustChanged]))).toEqual([
      'inactive_days',
      'user_id',
      'trust_score',
      'account_age_days',
      'server_id',
    ]);
    expect(variablesFor([newDevice, trustChanged])).toEqual([
      'user.username',
      'user.identityName',
      'server.name',
      'server.type',
    ]);
    const send = (body: string) => ({ type: 'send', to: [id(9)], body });
    expect(
      automationDefinitionSchema.safeParse({
        ...base,
        triggers: [newDevice],
        actions: { actions: [send('{{device.location}}')] },
      }).success
    ).toBe(true);
    expect(
      automationDefinitionSchema.safeParse({
        ...base,
        triggers: [trustChanged],
        actions: { actions: [send('{{device.location}}')] },
      }).success
    ).toBe(false);
  });
});

describe('automation payloads', () => {
  const conditions = {
    groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: 'video' }] }],
  };

  it('create requires name/kind/conditions/actions; update is partial', () => {
    expect(AUTOMATION_KINDS).toEqual(['policy', 'notification']);
    const payload = { ...base, triggers: [started], conditions };
    expect(createAutomationSchema.safeParse(payload).success).toBe(true);
    expect(updateAutomationSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(createAutomationSchema.safeParse({ ...payload, kind: 'other' }).success).toBe(false);
    expect(createAutomationSchema.safeParse({ ...payload, name: '' }).success).toBe(false);
    const { conditions: _dropped, ...withoutConditions } = payload;
    expect(createAutomationSchema.safeParse(withoutConditions).success).toBe(false);
  });

  it('takes at most one scope', () => {
    const payload = {
      ...base,
      triggers: [started],
      kind: 'policy',
      severity: 'warning',
      conditions,
      actions: { actions: [{ type: 'trust', mode: 'adjust', amount: -5 }] },
    };
    expect(createAutomationSchema.safeParse({ ...payload, serverId: id(6) }).success).toBe(true);
    expect(
      createAutomationSchema.safeParse({ ...payload, serverId: id(6), userId: id(7) }).success
    ).toBe(false);
    expect(updateAutomationSchema.safeParse({ serverId: id(6), userId: id(7) }).success).toBe(
      false
    );
  });

  it('a server-scoped automation cannot enforce across servers', () => {
    const payload = {
      ...base,
      triggers: [started],
      kind: 'policy',
      severity: 'warning',
      conditions,
    };
    expect(
      createAutomationSchema.safeParse({
        ...payload,
        serverId: id(6),
        enforceAcrossServers: true,
      }).success
    ).toBe(false);
    expect(
      createAutomationSchema.safeParse({
        ...payload,
        serverId: id(6),
        enforceAcrossServers: false,
      }).success
    ).toBe(true);
    expect(
      createAutomationSchema.safeParse({ ...payload, userId: id(7), enforceAcrossServers: true })
        .success
    ).toBe(true);
    expect(
      updateAutomationSchema.safeParse({ serverId: id(6), enforceAcrossServers: true }).success
    ).toBe(false);
  });
});
