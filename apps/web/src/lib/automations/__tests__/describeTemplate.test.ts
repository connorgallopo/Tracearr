import { beforeAll, describe, expect, it } from 'vitest';
import { i18n, initI18n } from '@tracearr/translations';
import { materializeTemplate } from '@tracearr/shared';
import type { TemplateDefinition, TemplateInput } from '@tracearr/shared';
import {
  describeTemplate,
  templateDescription,
  templateDraft,
  templateInputLabel,
  templateName,
} from '../describeTemplate';
import type { Translate } from '../conditionFields';

let t: Translate;

beforeAll(async () => {
  await initI18n({ lng: 'en' });
  t = i18n.getFixedT(null, 'pages');
});

const definition = (overrides: Partial<TemplateDefinition> = {}): TemplateDefinition => ({
  kind: 'notification',
  triggers: [{ id: 'trigger-1', type: 'session.started', enabled: true }],
  conditions: { groups: [] },
  actions: {
    actions: [{ id: 'action-1', type: 'send', enabled: true, to: { $input: 'to' } }],
  },
  scope: { serverId: { $input: 'server' } },
  enforceAcrossServers: false,
  cooldownMinutes: null,
  ...overrides,
});

const inputs: TemplateInput[] = [
  { key: 'server', kind: 'server', label: 'Server', required: false },
  { key: 'to', kind: 'destinations', label: 'Send to', required: true },
];

/** The one builtin shape with a required input that carries no default: a list of countries. */
const geo = (): { inputs: TemplateInput[]; definition: TemplateDefinition } => ({
  inputs: [
    {
      key: 'countries',
      kind: 'field_value',
      field: 'country',
      label: 'Blocked countries',
      required: true,
    },
  ],
  definition: definition({
    actions: { actions: [{ id: 'action-1', type: 'send', enabled: true, to: ['dest-1'] }] },
    scope: {},
    conditions: {
      groups: [
        {
          id: 'group-1',
          enabled: true,
          conditions: [
            {
              id: 'cond-1',
              enabled: true,
              field: 'country',
              operator: 'in',
              value: { $input: 'countries' },
            },
          ],
        },
      ],
    },
  }),
});

const held = (): TemplateDefinition =>
  definition({
    triggers: [
      {
        id: 'trigger-1',
        type: 'session.held_for',
        enabled: true,
        params: { minutes: { $input: 'minutes' }, measure: 'current' },
      },
    ],
  });

function text(
  version: { inputs: TemplateInput[]; definition: TemplateDefinition },
  bound: Record<string, unknown> = {},
  refs = {}
): string {
  return describeTemplate(version, bound, refs, t, 'metric')
    .map((fragment) => fragment.text)
    .join(' ');
}

describe('describeTemplate', () => {
  it('reads an unpicked destination as a notification rather than as a field name', () => {
    expect(text({ inputs, definition: definition() })).toBe(
      'When a stream starts, send a notification.'
    );
  });

  it('reads an unbound optional input as its default', () => {
    const version = {
      inputs: [
        ...inputs,
        {
          key: 'minutes',
          kind: 'duration',
          unit: 'minutes',
          label: 'Minutes paused',
          required: false,
          default: 30,
        } satisfies TemplateInput,
      ],
      definition: held(),
    };

    expect(text(version)).toBe(
      'When a stream has been paused for 30 minutes, send a notification.'
    );
  });

  it('drops the scope tail while the optional server is unbound', () => {
    expect(text({ inputs, definition: definition() })).not.toContain('Applies to');
  });

  it('names the server once one is bound', () => {
    const sentence = text(
      { inputs, definition: definition() },
      { server: 'server-1', to: ['dest-1'] },
      { servers: { 'server-1': 'Beehive' }, destinations: { 'dest-1': 'Discord' } }
    );

    expect(sentence).toBe('When a stream starts, send to Discord. Applies to Beehive.');
  });

  it('reads an unpicked country list as a plural, never as its field label', () => {
    expect(text(geo())).toBe(
      'When a stream starts, and only if the country is one of those chosen; send a notification.'
    );
  });

  it('names the countries once they are picked', () => {
    const sentence = text(
      geo(),
      { countries: ['US', 'CA'] },
      { countries: { US: 'United States', CA: 'Canada' } }
    );

    expect(sentence).toContain('the country is one of United States, Canada');
    expect(sentence).not.toContain('those chosen');
  });

  it('reads an unanswered slot as the kind of thing it holds', () => {
    const version = {
      inputs: [
        ...inputs,
        {
          key: 'minutes',
          kind: 'duration',
          unit: 'minutes',
          label: 'Minutes paused',
          required: true,
        } satisfies TemplateInput,
      ],
      definition: held(),
    };

    expect(text(version)).toContain('paused for a chosen length of time');
  });

  it('reads an emptied destination pick the same as one never made', () => {
    expect(text({ inputs, definition: definition() }, { to: [] })).toContain('send a notification');
  });

  it('converts a duration input into the unit its slot stores', () => {
    const version = {
      inputs: [
        ...inputs,
        {
          key: 'minutes',
          kind: 'duration',
          unit: 'hours',
          label: 'Hours paused',
          required: false,
          default: 2,
        } satisfies TemplateInput,
      ],
      definition: held(),
    };

    expect(text(version)).toContain('paused for 120 minutes');
  });

  it('lands an hours input on a cooldown_minutes slot as the same minutes the server stores', () => {
    const hours: TemplateInput = {
      key: 'quiet',
      kind: 'duration',
      unit: 'hours',
      label: 'Quiet for',
      required: true,
    };
    // materializeTemplate validates its result, so every id here is a real one.
    const sendId = 'c4d5e6f7-8a9b-4c1d-8e2f-3a4b5c6d7e8f';
    const version = {
      inputs: [...inputs, hours],
      definition: definition({
        triggers: [
          { id: '7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b', type: 'session.started', enabled: true },
        ],
        actions: {
          actions: [
            {
              id: sendId,
              type: 'send',
              enabled: true,
              to: { $input: 'to' },
              cooldown_minutes: { $input: 'quiet' },
            },
          ],
        },
      }),
    };
    // materializeTemplate validates its result, so the ids have to be real ones.
    const bound = {
      server: '2f1c0d9e-7a53-4b21-9c4e-11d2a3b4c5d6',
      to: ['9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'],
      quiet: 2,
    };

    const drafted = templateDraft(version, bound, { name: 'Quiet hours', isActive: true });
    const materialized = materializeTemplate(version, bound, { name: 'Quiet hours' });

    expect(drafted.actions.actions[0]).toMatchObject({ cooldown_minutes: 120 });
    expect(materialized.actions.actions[0]).toMatchObject({ cooldown_minutes: 120 });
  });
});

describe('template copy', () => {
  it('hands an envelope its own words back, so a $t(...) name never resolves', () => {
    const name = 'Handy policy $t(automations.gallery.builtin)';
    const description = 'Reads $t(automations.gallery.builtin) if i18next ever sees it';

    expect(templateName(t, { slug: 'pasted-one', name })).toBe(name);
    expect(templateDescription(t, { slug: 'pasted-one', description })).toBe(description);
  });

  it('still prefers the catalog copy for a template the app ships', () => {
    expect(templateName(t, { slug: 'stream-started', name: 'whatever the envelope said' })).toBe(
      'Stream started'
    );
  });

  it('names every bundled template from the catalog rather than its envelope', () => {
    const shipped = i18n.getResource('en', 'pages', 'automations.templates') as Record<
      string,
      { name?: string; description?: string }
    >;
    const slugs = Object.keys(shipped);

    expect(slugs).toHaveLength(22);
    expect(slugs).toContain('new-device');
    expect(slugs).toContain('trust-score-changed');

    for (const slug of slugs) {
      expect(templateName(t, { slug, name: 'envelope name' })).not.toBe('envelope name');
      expect(templateDescription(t, { slug, description: 'envelope text' })).not.toBe(
        'envelope text'
      );
    }

    expect(templateName(t, { slug: 'new-device', name: 'envelope name' })).toBe('New device');
    expect(templateName(t, { slug: 'trust-score-changed', name: 'envelope name' })).toBe(
      'Trust score changed'
    );
  });
});

describe('templateInputLabel', () => {
  it('prefers the wording the app uses when the template names a bare kind', () => {
    const input: TemplateInput = {
      key: 'server',
      kind: 'server',
      label: 'Server',
      required: false,
    };

    expect(templateInputLabel(t, input)).toBe('Which server');
  });

  it('keeps a label that says something of its own', () => {
    const input: TemplateInput = {
      key: 'to',
      kind: 'destinations',
      label: 'Send to',
      required: true,
    };

    expect(templateInputLabel(t, input)).toBe('Send to');
  });
});

describe('describeTemplate input keys', () => {
  const keysFor = (
    version: { inputs: TemplateInput[]; definition: TemplateDefinition },
    bound: Record<string, unknown> = {},
    match?: string
  ) => {
    const fragments = describeTemplate(version, bound, {}, t, 'metric');
    const found = match ? fragments.filter((fragment) => fragment.text.includes(match)) : fragments;
    return found.flatMap((fragment) => fragment.inputKeys ?? []);
  };

  const minutes: TemplateInput = {
    key: 'minutes',
    kind: 'duration',
    unit: 'minutes',
    label: 'Minutes paused',
    required: false,
    default: 30,
  };

  it('carries the duration key on the trigger clause it wrote', () => {
    expect(keysFor({ inputs: [...inputs, minutes], definition: held() }, {}, 'paused')).toEqual([
      'minutes',
    ]);
  });

  it('carries a condition value key on the condition clause', () => {
    const version = {
      inputs: [
        { key: 'max', kind: 'number', label: 'Streams allowed', required: false, default: 3 },
      ] satisfies TemplateInput[],
      definition: definition({
        conditions: {
          groups: [
            {
              id: 'group-1',
              enabled: true,
              conditions: [
                {
                  id: 'condition-1',
                  enabled: true,
                  field: 'concurrent_streams',
                  operator: 'gt',
                  value: { $input: 'max' },
                },
              ],
            },
          ],
        },
        actions: { actions: [] },
      }),
    };

    expect(keysFor(version, {}, 'stream count')).toEqual(['max']);
  });

  it('carries the server key on the scope tail', () => {
    expect(
      keysFor({ inputs, definition: definition() }, { server: 'server-1' }, 'Applies to')
    ).toEqual(['server']);
  });

  it('leaves an input with no slot out of every fragment', () => {
    const version = {
      inputs: [
        ...inputs,
        {
          key: 'note',
          kind: 'text',
          label: 'Message shown',
          required: false,
        } satisfies TemplateInput,
      ],
      definition: definition(),
    };

    expect(keysFor(version, { note: 'hello' })).not.toContain('note');
  });

  it('keeps the unpicked destination on the clause it will fill', () => {
    expect(keysFor({ inputs, definition: definition() }, {}, 'send a notification')).toEqual([
      'to',
    ]);
  });
});

describe('templateDraft', () => {
  it('leaves an unanswered destination as the empty list the builder starts a send on', () => {
    const draft = templateDraft(
      { inputs, definition: definition() },
      {},
      {
        name: 'Stream started',
        isActive: true,
      }
    );

    expect(draft.actions.actions[0]).toEqual({
      id: 'action-1',
      type: 'send',
      enabled: true,
      to: [],
    });
    expect(draft.serverId).toBeNull();
  });

  it('empties an unanswered list of condition values too', () => {
    const draft = templateDraft(geo(), {}, { name: 'Blocked countries', isActive: true });

    expect(draft.conditions.groups[0]?.conditions[0]).toMatchObject({
      field: 'country',
      value: [],
    });
  });

  it('still drops an unanswered slot that holds one value', () => {
    const version = {
      inputs: [
        { key: 'note', kind: 'text', label: 'What it says', required: true },
      ] satisfies TemplateInput[],
      definition: definition({
        actions: {
          actions: [
            { id: 'action-1', type: 'message_client', enabled: true, message: { $input: 'note' } },
          ],
        },
        scope: {},
      }),
    };

    const draft = templateDraft(version, {}, { name: 'A word', isActive: true });

    expect(draft.actions.actions[0]).toEqual({
      id: 'action-1',
      type: 'message_client',
      enabled: true,
    });
  });

  it('carries the answers the reader typed', () => {
    const draft = templateDraft(
      { inputs, definition: definition() },
      { server: 'server-1', to: ['dest-1'] },
      { name: 'Mine', isActive: false }
    );

    expect(draft).toMatchObject({
      name: 'Mine',
      isActive: false,
      kind: 'notification',
      serverId: 'server-1',
    });
    expect(draft.actions.actions[0]).toMatchObject({ type: 'send', to: ['dest-1'] });
  });
});
