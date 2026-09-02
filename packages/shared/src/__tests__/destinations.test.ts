import { describe, expect, it } from 'vitest';
import {
  DESTINATION_KINDS,
  DESTINATION_TYPES,
  NOTIFICATION_EVENT_TYPES,
  SUBSCRIBABLE_EVENTS,
  destinationConfigSchema,
  createDestinationSchema,
  updateDestinationSchema,
  sendActionSchema,
  actionSchema,
} from '../index.js';

describe('DESTINATION_TYPES', () => {
  it('has a descriptor for every kind, and every descriptor names its kind', () => {
    for (const kind of DESTINATION_KINDS) {
      expect(DESTINATION_TYPES[kind].kind).toBe(kind);
    }
  });
  it('built-ins have no fields and cannot receive plugin updates', () => {
    for (const kind of ['push', 'web_toast'] as const) {
      expect(DESTINATION_TYPES[kind].builtin).toBe(true);
      expect(DESTINATION_TYPES[kind].fields).toEqual([]);
      expect(DESTINATION_TYPES[kind].events).not.toContain('plugin_update_available');
    }
  });
  it('every kind can carry the update and media events an automation renders', () => {
    for (const kind of DESTINATION_KINDS) {
      expect(DESTINATION_TYPES[kind].events).toContain('server_update_available');
      expect(DESTINATION_TYPES[kind].events).toContain('tracearr_update_available');
      expect(DESTINATION_TYPES[kind].events).toContain('media_added');
      expect(DESTINATION_TYPES[kind].events).toContain('media_upgraded');
    }
    expect(NOTIFICATION_EVENT_TYPES).toContain('media_upgraded');
    // The automation is the only way in: nothing subscribes to a media event directly.
    expect(SUBSCRIBABLE_EVENTS).toEqual(['violation_detected']);
  });
  it('every url field is secret and every secret field is marked', () => {
    for (const kind of DESTINATION_KINDS) {
      for (const f of DESTINATION_TYPES[kind].fields) {
        if (f.input === 'url') expect(f.secret).toBe(true);
        if (f.input === 'secret') expect(f.secret).toBe(true);
      }
    }
  });
});

describe('destinationConfigSchema', () => {
  it('discord requires a webhook url', () => {
    expect(destinationConfigSchema('discord').safeParse({}).success).toBe(false);
    expect(
      destinationConfigSchema('discord').safeParse({
        webhookUrl: 'https://discord.com/api/webhooks/x',
      }).success
    ).toBe(true);
  });
  it('ntfy: url required, topic defaults to tracearr, token optional', () => {
    const r = destinationConfigSchema('ntfy').safeParse({ url: 'https://ntfy.sh' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.topic).toBe('tracearr');
    expect(
      destinationConfigSchema('ntfy').safeParse({ url: 'https://ntfy.sh', topic: '' }).success
    ).toBe(false);
  });
  it('pushover requires both keys and has no url', () => {
    expect(destinationConfigSchema('pushover').safeParse({ userKey: 'u' }).success).toBe(false);
    expect(
      destinationConfigSchema('pushover').safeParse({ userKey: 'u', apiToken: 't' }).success
    ).toBe(true);
    expect(DESTINATION_TYPES.pushover.fields.some((f) => f.input === 'url')).toBe(false);
  });
  it('rejects unknown keys', () => {
    expect(
      destinationConfigSchema('discord').safeParse({ webhookUrl: 'https://x', extra: 1 }).success
    ).toBe(false);
  });
});

describe('SUBSCRIBABLE_EVENTS', () => {
  it('is violations only: every other event reaches a destination through an automation', () => {
    expect(SUBSCRIBABLE_EVENTS).toEqual(['violation_detected']);
  });
});

describe('createDestinationSchema', () => {
  it('rejects built-in types', () => {
    expect(
      createDestinationSchema.safeParse({
        name: 'x',
        type: 'push',
        config: {},
        events: [],
        enabled: true,
      }).success
    ).toBe(false);
  });

  it('accepts violation_detected and rejects any other subscription', () => {
    const create = (events: string[]) =>
      createDestinationSchema.safeParse({
        name: 'x',
        type: 'discord',
        config: { webhookUrl: 'https://x' },
        events,
        enabled: true,
      }).success;

    expect(create(['violation_detected'])).toBe(true);
    expect(create([])).toBe(true);
    expect(create(['plugin_update_available'])).toBe(false);
    expect(create(['stream_started'])).toBe(false);
  });

  it('narrows a patch to the same subscribable set', () => {
    expect(updateDestinationSchema.safeParse({ events: ['stream_started'] }).success).toBe(false);
    expect(
      updateDestinationSchema.safeParse({ events: ['violation_detected'], enabled: false }).success
    ).toBe(true);
  });
});

describe('send action', () => {
  it('requires at least one destination id and accepts cooldown', () => {
    expect(sendActionSchema.safeParse({ type: 'send', to: [] }).success).toBe(false);
    expect(
      actionSchema.safeParse({
        type: 'send',
        to: ['3f2c8f0e-1c4d-4c1a-9c2e-6f0b6f5c9a11'],
        cooldown_minutes: 5,
      }).success
    ).toBe(true);
    expect(actionSchema.safeParse({ type: 'notify', channels: ['push'] }).success).toBe(false);
  });
});

import {
  EMAIL_SMTP_PRESETS,
  configSchemaForFields,
  type DestinationFieldDescriptor,
} from '../index.js';

describe('configSchemaForFields', () => {
  const fields: readonly DestinationFieldDescriptor[] = [
    {
      key: 'mode',
      label: 'mode',
      input: 'select',
      required: true,
      secret: false,
      default: 'a',
      options: [
        { value: 'a', label: 'modeA' },
        { value: 'b', label: 'modeB' },
      ],
    },
    {
      key: 'port',
      label: 'port',
      input: 'number',
      required: true,
      secret: false,
      default: '587',
      min: 1,
      max: 65535,
    },
    { key: 'from', label: 'from', input: 'email', required: true, secret: false },
    { key: 'cc', label: 'cc', input: 'email', required: false, secret: false },
    { key: 'to', label: 'to', input: 'emails', required: true, secret: false },
  ];
  const schema = configSchemaForFields(fields);

  it('accepts valid strings and fills defaults', () => {
    const parsed = schema.safeParse({ from: 'a@example.com', to: 'b@example.com, c@example.org' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({ mode: 'a', port: '587' });
    expect(parsed.data.port).toBe('587');
  });

  it.each([
    ['port', '0'],
    ['port', '70000'],
    ['port', 'abc'],
    ['port', '5.5'],
    ['mode', 'c'],
    ['from', 'not-an-address'],
    ['to', 'a@example.com, nope'],
    ['to', ''],
  ])('rejects %s = %s', (key, value) => {
    const parsed = schema.safeParse({ from: 'a@example.com', to: 'b@example.com', [key]: value });
    expect(parsed.success).toBe(false);
  });

  it('lets an optional address be null or empty', () => {
    expect(schema.safeParse({ from: 'a@example.com', to: 'b@example.com', cc: null }).success).toBe(
      true
    );
    expect(schema.safeParse({ from: 'a@example.com', to: 'b@example.com', cc: '' }).success).toBe(
      true
    );
  });

  it('still builds every existing kind unchanged', () => {
    for (const kind of DESTINATION_KINDS) {
      expect(destinationConfigSchema(kind)).toBeDefined();
    }
    expect(
      destinationConfigSchema('ntfy').safeParse({ url: 'https://ntfy.sh', topic: 't' }).success
    ).toBe(true);
  });
});

describe('EMAIL_SMTP_PRESETS', () => {
  it('every preset names a host, a port in range and a known security', () => {
    for (const [name, preset] of Object.entries(EMAIL_SMTP_PRESETS)) {
      expect(name).not.toBe('custom');
      expect(preset.host).toMatch(/^[a-z0-9.-]+$/);
      expect(Number(preset.port)).toBeGreaterThan(0);
      expect(['starttls', 'tls', 'none']).toContain(preset.security);
    }
  });
});
