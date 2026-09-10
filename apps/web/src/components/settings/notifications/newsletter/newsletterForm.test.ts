import { describe, it, expect } from 'vitest';
import type { Newsletter } from '@tracearr/shared';
import {
  deepEqual,
  defaultFormState,
  diffPatch,
  prefillFromRouterState,
  seedFromNewsletter,
  validateForm,
} from './newsletterForm';

const row: Newsletter = {
  id: 'n-1',
  name: 'Weekly',
  enabled: true,
  destinationId: '550e8400-e29b-41d4-a716-446655440000',
  schedule: { kind: 'weekly', dayOfWeek: 1, time: '09:00' },
  timezone: 'Europe/Berlin',
  window: { kind: 'since_last_send', fallbackDays: 7 },
  scope: { serverIds: [], libraries: [] },
  sections: {
    movies: { enabled: true, max: 12 },
    shows: { enabled: true, max: 12, maxSeasonsPerShow: 8 },
    music: { enabled: true, max: 8 },
    mostWatched: { enabled: false, max: 10 },
  },
  subject: 'Hello',
  senderName: null,
  intro: null,
  outro: null,
  recipients: { members: true, extraAddresses: [], excludeUserIds: [] },
  imageMode: 'auto',
  skipWhenEmpty: true,
  links: { tracearr: false },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  lastSend: null,
  nextRunAt: null,
};

describe('newsletter form model', () => {
  it('starts a new row on the create defaults and the browser zone', () => {
    const state = defaultFormState();
    expect(state.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(state.schedule).toEqual({ kind: 'weekly', dayOfWeek: 1, time: '09:00' });
    expect(state.name).toBe('');
    expect(state.links).toEqual({ tracearr: false });
    expect(validateForm(state)).toEqual({ name: expect.stringMatching(/>=1/) });
  });

  it('seeds from a row without the server-only fields', () => {
    const seed = seedFromNewsletter(row);
    expect(seed).not.toHaveProperty('id');
    expect(seed).not.toHaveProperty('lastSend');
    expect(seed.subject).toBe('Hello');
    expect(validateForm(seed)).toEqual({});
  });

  it('requires a sender name once the scope resolves to more than one server', () => {
    const seed = seedFromNewsletter(row);
    const opts = { scopedServerCount: 2, senderNameRequired: 'Pick a name' };
    expect(validateForm(seed, opts)).toEqual({ senderName: 'Pick a name' });
    expect(validateForm({ ...seed, senderName: 'Family' }, opts)).toEqual({});
    expect(validateForm(seed, { ...opts, scopedServerCount: 1 })).toEqual({});
  });

  it('diffs only the keys that moved, by value', () => {
    const seed = seedFromNewsletter(row);
    expect(diffPatch(seed, { ...seed })).toEqual({});
    expect(diffPatch(seed, { ...seed, name: 'Weekly ', links: { tracearr: false } })).toEqual({
      name: 'Weekly ',
    });
    expect(
      diffPatch(seed, { ...seed, scope: { serverIds: ['s-1'], libraries: [] }, enabled: false })
    ).toEqual({ scope: { serverIds: ['s-1'], libraries: [] }, enabled: false });
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: null }, { a: undefined })).toBe(false);
  });

  it('keeps the first issue per top-level field', () => {
    const seed = seedFromNewsletter(row);
    const errors = validateForm({
      ...seed,
      name: '',
      subject: '',
      recipients: {
        members: true,
        extraAddresses: [{ address: 'nope' }, { address: 'also' }],
        excludeUserIds: [],
      },
    });
    expect(Object.keys(errors).sort()).toEqual(['name', 'recipients', 'subject']);
    expect(errors.recipients).toMatch(/email/i);
  });
});

describe('prefillFromRouterState', () => {
  it('takes a destination id from router state and nothing else', () => {
    expect(prefillFromRouterState({ destinationId: 'd-1' })).toEqual({ destinationId: 'd-1' });
    expect(prefillFromRouterState({ destinationId: 7 })).toEqual({});
    expect(prefillFromRouterState({ name: 'x' })).toEqual({});
    expect(prefillFromRouterState(null)).toEqual({});
    expect(prefillFromRouterState(undefined)).toEqual({});
    expect(prefillFromRouterState('d-1')).toEqual({});
  });
});
