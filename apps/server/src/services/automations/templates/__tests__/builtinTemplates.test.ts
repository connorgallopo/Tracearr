/**
 * The bundled envelopes are data, so the checks a compiler cannot make live here:
 * they parse, their fingerprints are current, their node ids never collide, and
 * every one of them materializes into an automation the API would accept.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  TEMPLATE_MIN_SERVER_VERSION,
  createAutomationSchema,
  fingerprintOf,
  materializeTemplate,
  templateEnvelopeSchema,
  type TemplateEnvelope,
  type TemplateInput,
} from '@tracearr/shared';
import { BUILTIN_ENVELOPES } from '../builtin/index.js';

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

const SERVER_ID = '2b6b7f2c-6a1e-4a6f-9c33-1f7e2b0c9d10';
const DESTINATION_ID = '8c4a0d31-4f5b-4d0e-9a12-77c6d5b3e401';

/** What the binding form would send for a required input the envelope gives no default for. */
function sampleValue(input: TemplateInput): unknown {
  switch (input.kind) {
    case 'server':
    case 'account':
    case 'person':
      return SERVER_ID;
    case 'destinations':
      return [DESTINATION_ID];
    case 'field_value':
      return input.field === 'country' ? ['US'] : 'sample';
    default:
      return undefined;
  }
}

function bindingsFor(envelope: TemplateEnvelope): Record<string, unknown> {
  const bound: Record<string, unknown> = {};
  for (const input of envelope.inputs) {
    const value = sampleValue(input);
    if (value !== undefined) bound[input.key] = value;
  }
  return bound;
}

/** Slug, group and kind per the built-ins table in the phase-5 design. */
const TABLE: Array<[string, string, string]> = [
  ['stream-started', 'notifications', 'notification'],
  ['stream-ended', 'notifications', 'notification'],
  ['transcode-started', 'notifications', 'notification'],
  ['paused-too-long', 'notifications', 'notification'],
  ['media-added', 'notifications', 'notification'],
  ['media-upgraded', 'notifications', 'notification'],
  ['new-device', 'notifications', 'notification'],
  ['trust-score-changed', 'notifications', 'notification'],
  ['newsletter-failed', 'notifications', 'notification'],
  ['server-down', 'server_health', 'notification'],
  ['server-up', 'server_health', 'notification'],
  ['plugin-update', 'server_health', 'notification'],
  ['server-update', 'server_health', 'notification'],
  ['tracearr-update', 'server_health', 'notification'],
  ['concurrent-streams', 'policies', 'policy'],
  ['impossible-travel', 'policies', 'policy'],
  ['simultaneous-locations', 'policies', 'policy'],
  ['device-velocity', 'policies', 'policy'],
  ['geo-restriction', 'policies', 'policy'],
  ['account-inactivity', 'policies', 'policy'],
  ['no-4k-transcodes', 'policies', 'policy'],
  ['kill-paused-streams', 'housekeeping', 'notification'],
];

describe('builtin template envelopes', () => {
  it('bundles the twenty-two templates the design names, in its order', () => {
    expect(BUILTIN_ENVELOPES.map((envelope) => envelope.slug)).toEqual(TABLE.map(([slug]) => slug));
  });

  it('parses every envelope and carries a current fingerprint', () => {
    for (const envelope of BUILTIN_ENVELOPES) {
      expect(templateEnvelopeSchema.safeParse(envelope).success).toBe(true);
      expect(envelope.fingerprint).toBe(fingerprintOf(envelope, sha256Hex));
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.minServerVersion).toBe(TEMPLATE_MIN_SERVER_VERSION);
    }
  });

  it('gives every node in the catalog its own id', () => {
    const ids = BUILTIN_ENVELOPES.flatMap((envelope) => [
      ...JSON.stringify(envelope.definition).matchAll(/"id":"([^"]+)"/g),
    ]).map((match) => match[1]);
    expect(ids.length).toBeGreaterThanOrEqual(BUILTIN_ENVELOPES.length * 2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(TABLE)('%s sits in the group and kind the table gives it', (slug, group, kind) => {
    const envelope = BUILTIN_ENVELOPES.find((candidate) => candidate.slug === slug);
    expect(envelope?.group).toBe(group);
    expect(envelope?.kind).toBe(kind);
    expect(envelope?.definition.severity ?? null).toBe(kind === 'policy' ? 'warning' : null);
  });

  it.each(TABLE.map(([slug]) => slug))('%s materializes into a valid automation', (slug) => {
    const envelope = BUILTIN_ENVELOPES.find((candidate) => candidate.slug === slug);
    if (!envelope) throw new Error(`no envelope for ${slug}`);
    const created = materializeTemplate(envelope, bindingsFor(envelope), { name: envelope.name });
    expect(createAutomationSchema.safeParse(created).success).toBe(true);
    expect(created.triggers?.length ?? 0).toBeGreaterThan(0);
  });

  it('binds a server scope wherever the envelope declares a server input', () => {
    for (const envelope of BUILTIN_ENVELOPES) {
      const takesServer = envelope.inputs.some((input) => input.kind === 'server');
      const created = materializeTemplate(envelope, bindingsFor(envelope), { name: 'bound' });
      expect(created.serverId ?? null).toBe(takesServer ? SERVER_ID : null);
    }
  });

  it('leaves an unbound optional server global', () => {
    const envelope = BUILTIN_ENVELOPES.find((candidate) => candidate.slug === 'stream-started');
    if (!envelope) throw new Error('stream-started is missing');
    const created = materializeTemplate(
      envelope,
      { to: [DESTINATION_ID] },
      { name: 'every server' }
    );
    expect(created.serverId).toBeUndefined();
  });

  it('takes a media automation with no server bound and every library on it', () => {
    const envelope = BUILTIN_ENVELOPES.find((candidate) => candidate.slug === 'media-added');
    if (!envelope) throw new Error('media-added is missing');

    const created = materializeTemplate(
      envelope,
      { server: null, to: [DESTINATION_ID] },
      { name: 'New in the library' }
    );

    expect(createAutomationSchema.safeParse(created).success).toBe(true);
    expect(created.serverId ?? null).toBeNull();
    expect(created.triggers?.map((trigger) => trigger.type)).toEqual(['media.added']);
    expect(created.actions.actions).toEqual([
      expect.objectContaining({ type: 'send', to: [DESTINATION_ID] }),
    ]);
  });

  it('leaves the media send its own default copy, with no title or body', () => {
    for (const slug of ['media-added', 'media-upgraded']) {
      const envelope = BUILTIN_ENVELOPES.find((candidate) => candidate.slug === slug);
      const send = envelope?.definition.actions.actions[0];
      expect(send).toMatchObject({ type: 'send' });
      expect(send && 'title' in send ? send.title : undefined).toBeUndefined();
      expect(send && 'body' in send ? send.body : undefined).toBeUndefined();
    }
  });

  it('converts a duration input into the unit its slot stores', () => {
    const envelope = BUILTIN_ENVELOPES.find((candidate) => candidate.slug === 'device-velocity');
    if (!envelope) throw new Error('device-velocity is missing');
    const created = materializeTemplate(envelope, { hours: 2 }, { name: 'two hours' });
    expect(created.conditions.groups[0]?.conditions[0]?.params?.window_hours).toBe(2);
  });

  it('kills a 4K transcode only when the video itself is being transcoded', () => {
    const envelope = BUILTIN_ENVELOPES.find((candidate) => candidate.slug === 'no-4k-transcodes');
    if (!envelope) throw new Error('no-4k-transcodes is missing');
    const conditions = envelope.definition.conditions.groups.map((group) => group.conditions[0]);
    expect(conditions.map((condition) => [condition?.field, condition?.value])).toEqual([
      ['source_resolution', '4K'],
      ['is_transcoding', 'video'],
    ]);
  });

  it('drops the local-network group when the LAN toggle is off', () => {
    const envelope = BUILTIN_ENVELOPES.find((candidate) => candidate.slug === 'geo-restriction');
    if (!envelope) throw new Error('geo-restriction is missing');
    const on = materializeTemplate(envelope, { countries: ['US'] }, { name: 'blocked' });
    const off = materializeTemplate(
      envelope,
      { countries: ['US'], ignoreLan: false },
      { name: 'blocked' }
    );
    expect(on.conditions.groups[1]?.enabled).toBe(true);
    expect(off.conditions.groups[1]?.enabled).toBe(false);
  });
});
