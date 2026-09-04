import { describe, expect, it } from 'vitest';
import {
  TRIGGERS,
  TRIGGER_GROUPS,
  TRIGGER_TYPES,
  contextOf,
  contextSupplies,
  variablesFor,
} from '../index.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const started = { id: id(1), type: 'session.started', enabled: true } as const;
const down = { id: id(2), type: 'server.down', enabled: true } as const;
const added = { id: id(3), type: 'media.added', enabled: true } as const;
const upgraded = { id: id(4), type: 'media.upgraded', enabled: true } as const;
const newDevice = { id: id(5), type: 'account.new_device', enabled: true } as const;
const trustChanged = { id: id(6), type: 'account.trust_changed', enabled: true } as const;

describe('trigger contexts', () => {
  it('walks the parent chain to say what a context supplies', () => {
    expect(contextSupplies('media', 'server')).toBe(true);
    expect(contextSupplies('media', 'account')).toBe(false);
    expect(contextSupplies('session', 'media')).toBe(false);
    expect(contextSupplies('session', 'account')).toBe(true);
    expect(contextSupplies('server', 'server')).toBe(true);
    expect(contextSupplies('install', 'server')).toBe(false);
  });

  it('meets a media trigger and a session one at the server they share', () => {
    expect(contextOf([started, added])).toBe('server');
    expect(contextOf([added, upgraded])).toBe('media');
    expect(contextOf([added])).toBe('media');
    expect(contextOf([started, down])).toBe('server');
  });

  it('meets a new-device trigger with the account it sits under and the server beyond it', () => {
    expect(contextOf([newDevice])).toBe('session');
    expect(contextOf([newDevice, trustChanged])).toBe('account');
    expect(contextOf([newDevice, added])).toBe('server');
  });

  it('lists every catalog key', () => {
    expect(TRIGGER_TYPES).toEqual(Object.keys(TRIGGERS));
  });

  it('ignores disabled triggers', () => {
    expect(contextOf([started, { ...down, enabled: false }])).toBe('session');
    expect(contextOf([{ ...started, enabled: false }])).toBeNull();
    expect(variablesFor([started, { ...down, enabled: false }])).toContain('user.username');
  });

  it('offers no variables when nothing is enabled', () => {
    expect(variablesFor([])).toEqual([]);
  });
});

describe('newsletter triggers', () => {
  it('sit in the install context under the notifications group and offer the send variables', () => {
    expect(TRIGGERS['newsletter.sent']).toEqual({
      context: 'install',
      group: 'notifications',
      variables: [
        'newsletter.name',
        'newsletter.outcome',
        'newsletter.recipientCount',
        'newsletter.error',
      ],
    });
    expect(TRIGGERS['newsletter.failed'].context).toBe('install');
    expect(TRIGGER_GROUPS).toContain('notifications');
    expect(contextOf([{ id: id(7), type: 'newsletter.failed', enabled: true }])).toBe('install');
  });
});
