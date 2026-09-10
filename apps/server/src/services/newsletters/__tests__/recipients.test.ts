import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecute = vi.fn();
vi.mock('../../../db/client.js', () => ({
  db: { execute: (...a: unknown[]) => mockExecute(...a) as unknown },
}));
const mockSuppressed = vi.fn();
vi.mock('../suppressions.js', async (importActual) => ({
  ...(await importActual<typeof import('../suppressions.js')>()),
  suppressedAmong: (...a: unknown[]) => mockSuppressed(...a) as unknown,
}));

import { mergeRecipients, resolveRecipients, type RecipientCandidate } from '../recipients.js';

const c = (over: Partial<RecipientCandidate>): RecipientCandidate => ({
  userId: 'u1',
  serverUserId: 'su-u1',
  name: null,
  username: null,
  serverId: 's1',
  serverName: 'Server One',
  serverIds: ['s1'],
  thumbUrl: null,
  contactEmail: null,
  identityEmail: null,
  accountEmails: [],
  blocked: null,
  ...over,
});

describe('mergeRecipients', () => {
  it('prefers contact email, then identity email, then the first account email', () => {
    const { recipients } = mergeRecipients(
      [
        c({
          userId: 'u1',
          contactEmail: 'c@x.com',
          identityEmail: 'i@x.com',
          accountEmails: ['a@x.com'],
        }),
        c({ userId: 'u2', identityEmail: 'i2@x.com', accountEmails: ['a2@x.com'] }),
        c({ userId: 'u3', accountEmails: ['a3@x.com', 'b3@x.com'] }),
      ],
      [],
      new Set()
    );
    expect(recipients.map((r) => [r.userId, r.address])).toEqual([
      ['u1', 'c@x.com'],
      ['u2', 'i2@x.com'],
      ['u3', 'a3@x.com'],
    ]);
  });

  it('lowercases, dedupes by address with the first identity winning, and lists the address-less', () => {
    const { recipients, missing, excluded } = mergeRecipients(
      [
        c({ userId: 'u1', serverUserId: 'su-u1', name: 'One', contactEmail: 'Shared@X.com' }),
        c({ userId: 'u2', serverUserId: 'su-u2', name: 'Two', identityEmail: 'shared@x.com' }),
        c({ userId: 'u3', serverUserId: 'su-u3', name: 'Three' }),
      ],
      [],
      new Set()
    );
    expect(recipients).toEqual([
      {
        address: 'shared@x.com',
        userId: 'u1',
        serverUserId: 'su-u1',
        name: 'One',
        suppressed: false,
        username: null,
        serverId: 's1',
        serverName: 'Server One',
        serverIds: ['s1'],
        thumbUrl: null,
      },
    ]);
    expect(missing).toEqual([
      {
        userId: 'u3',
        serverUserId: 'su-u3',
        name: 'Three',
        username: null,
        serverId: 's1',
        serverName: 'Server One',
        serverIds: ['s1'],
        thumbUrl: null,
      },
    ]);
    expect(excluded).toEqual([]);
  });

  it('sets excluded identities aside before addressing them', () => {
    const { recipients, missing, excluded } = mergeRecipients(
      [
        c({ userId: 'u1', serverUserId: 'su-u1', name: 'One', contactEmail: 'one@x.com' }),
        c({ userId: 'u2', serverUserId: 'su-u2', name: 'Two', contactEmail: 'two@x.com' }),
        c({ userId: 'u3', serverUserId: 'su-u3', name: 'Three' }),
      ],
      [],
      new Set(),
      ['u2', 'u3']
    );
    expect(recipients).toEqual([
      {
        address: 'one@x.com',
        userId: 'u1',
        serverUserId: 'su-u1',
        name: 'One',
        suppressed: false,
        username: null,
        serverId: 's1',
        serverName: 'Server One',
        serverIds: ['s1'],
        thumbUrl: null,
      },
    ]);
    expect(missing).toEqual([]);
    expect(excluded).toEqual([
      {
        userId: 'u2',
        serverUserId: 'su-u2',
        name: 'Two',
        username: null,
        serverId: 's1',
        serverName: 'Server One',
        serverIds: ['s1'],
        thumbUrl: null,
        reason: 'excluded',
      },
      {
        userId: 'u3',
        serverUserId: 'su-u3',
        name: 'Three',
        username: null,
        serverId: 's1',
        serverName: 'Server One',
        serverIds: ['s1'],
        thumbUrl: null,
        reason: 'excluded',
      },
    ]);
  });

  it('sets banned and pending identities aside with their reason, ahead of the owner exclusion', () => {
    const { recipients, missing, excluded } = mergeRecipients(
      [
        c({ userId: 'u1', serverUserId: 'su-u1', name: 'One', contactEmail: 'one@x.com' }),
        c({
          userId: 'u2',
          serverUserId: 'su-u2',
          name: 'Two',
          contactEmail: 'two@x.com',
          blocked: 'banned',
        }),
        c({ userId: 'u3', serverUserId: 'su-u3', name: 'Three', blocked: 'pending' }),
      ],
      [],
      new Set(),
      ['u1', 'u2']
    );
    expect(recipients).toEqual([]);
    expect(missing).toEqual([]);
    expect(excluded).toEqual([
      {
        userId: 'u1',
        serverUserId: 'su-u1',
        name: 'One',
        username: null,
        serverId: 's1',
        serverName: 'Server One',
        serverIds: ['s1'],
        thumbUrl: null,
        reason: 'excluded',
      },
      {
        userId: 'u2',
        serverUserId: 'su-u2',
        name: 'Two',
        username: null,
        serverId: 's1',
        serverName: 'Server One',
        serverIds: ['s1'],
        thumbUrl: null,
        reason: 'banned',
      },
      {
        userId: 'u3',
        serverUserId: 'su-u3',
        name: 'Three',
        username: null,
        serverId: 's1',
        serverName: 'Server One',
        serverIds: ['s1'],
        thumbUrl: null,
        reason: 'pending',
      },
    ]);
  });

  it('appends extras that are not already present and flags suppressed addresses', () => {
    const { recipients } = mergeRecipients(
      [c({ userId: 'u1', contactEmail: 'a@x.com' })],
      [
        { address: 'A@X.com', name: 'dup' },
        { address: 'extra@x.com', name: 'Extra' },
      ],
      new Set(['extra@x.com'])
    );
    expect(recipients).toEqual([
      {
        address: 'a@x.com',
        userId: 'u1',
        serverUserId: 'su-u1',
        name: null,
        suppressed: false,
        username: null,
        serverId: 's1',
        serverName: 'Server One',
        serverIds: ['s1'],
        thumbUrl: null,
      },
      {
        address: 'extra@x.com',
        userId: null,
        serverUserId: null,
        name: 'Extra',
        suppressed: true,
        username: null,
        serverId: null,
        serverName: null,
        serverIds: [],
        thumbUrl: null,
      },
    ]);
  });

  it('returns only extras when members are not included', () => {
    const { recipients, missing, excluded } = mergeRecipients(
      [],
      [{ address: 'x@y.com' }],
      new Set()
    );
    expect(recipients).toEqual([
      {
        address: 'x@y.com',
        userId: null,
        serverUserId: null,
        name: null,
        suppressed: false,
        username: null,
        serverId: null,
        serverName: null,
        serverIds: [],
        thumbUrl: null,
      },
    ]);
    expect(missing).toEqual([]);
    expect(excluded).toEqual([]);
  });

  it('carries every scoped server of the identity onto the recipient and none onto an extra address', () => {
    const { recipients } = mergeRecipients(
      [c({ userId: 'u1', contactEmail: 'both@x.com', serverIds: ['s1', 's2'] })],
      [{ address: 'extra@x.com' }],
      new Set()
    );
    expect(recipients.map((r) => [r.address, r.serverIds])).toEqual([
      ['both@x.com', ['s1', 's2']],
      ['extra@x.com', []],
    ]);
  });
});

describe('resolveRecipients', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockSuppressed.mockReset().mockResolvedValue(new Set(['gone@x.com']));
  });

  it('skips the database when members are not included and still checks extras for suppression', async () => {
    const out = await resolveRecipients({
      scope: { serverIds: [], libraries: [] },
      recipients: {
        members: false,
        extraAddresses: [{ address: 'Gone@X.com' }, { address: 'new@x.com', name: 'New' }],
        excludeUserIds: [],
      },
    });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockSuppressed).toHaveBeenCalledWith(['gone@x.com', 'new@x.com']);
    expect(out).toEqual({
      recipients: [
        {
          address: 'gone@x.com',
          userId: null,
          serverUserId: null,
          name: null,
          suppressed: true,
          username: null,
          serverId: null,
          serverName: null,
          serverIds: [],
          thumbUrl: null,
        },
        {
          address: 'new@x.com',
          userId: null,
          serverUserId: null,
          name: 'New',
          suppressed: false,
          username: null,
          serverId: null,
          serverName: null,
          serverIds: [],
          thumbUrl: null,
        },
      ],
      missing: [],
      excluded: [],
    });
  });

  it('loads candidates, asks suppression about every resolvable address plus extras, and merges', async () => {
    mockExecute.mockResolvedValue({
      rows: [
        {
          user_id: 'u1',
          server_user_id: 'su-u1',
          name: 'One',
          contact_email: null,
          identity_email: 'One@X.com',
          account_emails: ['a1@x.com'],
          usernames: ['user-one'],
          server_ids: ['s1'],
          server_names: ['Basement Plex'],
          thumb_urls: ['/thumb1'],
        },
        {
          user_id: 'u2',
          server_user_id: 'su-u2',
          name: null,
          contact_email: null,
          identity_email: null,
          account_emails: null,
          usernames: ['garry'],
          server_ids: ['s2'],
          server_names: ['Basement Jellyfin'],
          thumb_urls: [null],
        },
      ],
    });
    const out = await resolveRecipients({
      scope: { serverIds: ['11111111-1111-4111-8111-111111111111'], libraries: [] },
      recipients: {
        members: true,
        extraAddresses: [{ address: 'extra@x.com' }],
        excludeUserIds: [],
      },
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockSuppressed).toHaveBeenCalledWith(['one@x.com', 'extra@x.com']);
    expect(
      out.recipients.map((r) => [r.address, r.userId, r.suppressed, r.username, r.serverName])
    ).toEqual([
      ['one@x.com', 'u1', false, 'user-one', 'Basement Plex'],
      ['extra@x.com', null, false, null, null],
    ]);
    expect(out.missing).toEqual([
      {
        userId: 'u2',
        serverUserId: 'su-u2',
        name: null,
        username: 'garry',
        serverId: 's2',
        serverName: 'Basement Jellyfin',
        serverIds: ['s2'],
        thumbUrl: null,
      },
    ]);
    expect(out.excluded).toEqual([]);
  });

  it('does not ask suppression about an excluded identity', async () => {
    mockExecute.mockResolvedValue({
      rows: [
        {
          user_id: 'u1',
          server_user_id: 'su-u1',
          name: 'One',
          contact_email: 'one@x.com',
          identity_email: null,
          account_emails: null,
          usernames: ['one'],
          server_ids: ['s1'],
          server_names: ['Server'],
          thumb_urls: [null],
        },
        {
          user_id: 'u2',
          server_user_id: 'su-u2',
          name: 'Two',
          contact_email: 'two@x.com',
          identity_email: null,
          account_emails: null,
          usernames: ['two'],
          server_ids: ['s1'],
          server_names: ['Server'],
          thumb_urls: [null],
        },
        {
          user_id: 'u3',
          server_user_id: 'su-u3',
          name: 'Three',
          contact_email: 'three@x.com',
          identity_email: null,
          account_emails: null,
          usernames: ['three'],
          server_ids: ['s1'],
          server_names: ['Server'],
          thumb_urls: [null],
          blocked: 'banned',
        },
      ],
    });
    const out = await resolveRecipients({
      scope: { serverIds: [], libraries: [] },
      recipients: { members: true, extraAddresses: [], excludeUserIds: ['u2'] },
    });
    expect(mockSuppressed).toHaveBeenCalledWith(['one@x.com']);
    expect(out.recipients.map((r) => r.address)).toEqual(['one@x.com']);
    expect(out.excluded).toEqual([
      {
        userId: 'u2',
        serverUserId: 'su-u2',
        name: 'Two',
        username: 'two',
        serverId: 's1',
        serverName: 'Server',
        serverIds: ['s1'],
        thumbUrl: null,
        reason: 'excluded',
      },
      {
        userId: 'u3',
        serverUserId: 'su-u3',
        name: 'Three',
        username: 'three',
        serverId: 's1',
        serverName: 'Server',
        serverIds: ['s1'],
        thumbUrl: null,
        reason: 'banned',
      },
    ]);
  });
});
