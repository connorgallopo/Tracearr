import { describe, it, expect } from 'vitest';
import type { Newsletter } from '@tracearr/shared';
import {
  deepEqual,
  defaultFormState,
  diffPatch,
  firstInvalidField,
  focusTargetId,
  prefillFromRouterState,
  scopeMoved,
  seedFromNewsletter,
  validateForm,
  visibleErrors,
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
  it('starts a new newsletter with posters attached', () => {
    expect(defaultFormState().imageMode).toBe('inline');
  });

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
    const opts = {
      scopedServerCount: 2,
      messages: {
        required: 'Required',
        maxLength: (max: number) => `At most ${max}`,
        senderNameRequired: 'Pick a name',
      },
    };
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

  it('maps the two string issues the form can raise to the given messages and leaves the rest raw', () => {
    const messages = {
      required: 'Required',
      maxLength: (max: number) => `At most ${max}`,
      senderNameRequired: 'Pick a name',
    };
    const blank = validateForm(defaultFormState(), { scopedServerCount: 1, messages });
    expect(blank).toEqual({ name: 'Required' });
    const long = validateForm(
      { ...defaultFormState(), name: 'x'.repeat(101) },
      { scopedServerCount: 1, messages }
    );
    expect(long).toEqual({ name: 'At most 100' });
    const multi = validateForm(
      { ...defaultFormState(), name: 'Weekly' },
      { scopedServerCount: 2, messages }
    );
    expect(multi).toEqual({ senderName: 'Pick a name' });
    const cron = validateForm(
      { ...defaultFormState(), name: 'Weekly', schedule: { kind: 'cron', expression: 'nope' } },
      { scopedServerCount: 1, messages }
    );
    expect(cron.schedule).toBe('Cron needs five fields made of digits, *, comma, dash and slash');
  });

  it('shows an error only for a touched field until the form is submitted', () => {
    const errors = { name: 'Required', senderName: 'Pick a name' };
    expect(visibleErrors(errors, {}, false)).toEqual({});
    expect(visibleErrors(errors, { name: true }, false)).toEqual({ name: 'Required' });
    expect(visibleErrors(errors, {}, true)).toEqual(errors);
  });

  it('names the first invalid field in page order and the control that answers for it', () => {
    const state = defaultFormState();
    expect(firstInvalidField({ senderName: 'x', name: 'y' })).toBe('name');
    expect(firstInvalidField({})).toBeNull();
    expect(focusTargetId('name', state)).toBe('newsletter-name');
    expect(focusTargetId('schedule', state)).toBe('newsletter-time');
    expect(
      focusTargetId('schedule', { ...state, schedule: { kind: 'cron', expression: '* * * * *' } })
    ).toBe('newsletter-cron');
    expect(focusTargetId('sections', state)).toBe('newsletter-section-cap-movies');
    expect(focusTargetId('destinationId', state)).toBe('newsletter-destination');
    expect(focusTargetId('recipients', state)).toBe('newsletter-members');
  });
});

describe('scopeMoved', () => {
  it('never flags a form that has never been saved, and compares the ids in order otherwise', () => {
    expect(scopeMoved(null, ['s-1'])).toBe(false);
    expect(scopeMoved(null, [])).toBe(false);
    expect(scopeMoved(['s-1'], ['s-1'])).toBe(false);
    expect(scopeMoved(['s-1'], ['s-2'])).toBe(true);
    expect(scopeMoved([], ['s-1'])).toBe(true);
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
