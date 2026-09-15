import { describe, it, expect } from 'vitest';
import type { NewsletterExcludedPerson, NewsletterResolvedRecipient } from '@tracearr/shared';
import {
  entryOnServer,
  excludedEntry,
  groupByVariant,
  matchesSearch,
  partitionRecipients,
  pendingChange,
  recipientEntry,
  SUMMARY_ROWS,
  summaryEntries,
} from './recipientsView';

const member = (
  userId: string,
  name: string,
  over: Partial<NewsletterResolvedRecipient> = {}
): NewsletterResolvedRecipient => ({
  address: `${name.toLowerCase()}@x.com`,
  userId,
  serverUserId: `su-${userId}`,
  name,
  suppressed: false,
  username: name.toLowerCase(),
  serverId: 's1',
  serverName: 'Home Plex',
  serverIds: ['s1'],
  thumbUrl: null,
  newSinceLastSend: false,
  addressFromUsername: false,
  ...over,
});

const excluded = (
  userId: string,
  name: string,
  reason: NewsletterExcludedPerson['reason']
): NewsletterExcludedPerson => ({
  userId,
  serverUserId: `su-${userId}`,
  name,
  username: name.toLowerCase(),
  serverId: 's1',
  serverName: 'Home Plex',
  serverIds: ['s1'],
  thumbUrl: null,
  reason,
});

describe('partitionRecipients', () => {
  it('splits the view into mailed, suppressed, excluded by the owner, and not includable', () => {
    const out = partitionRecipients({
      recipients: [member('u1', 'Ann'), member('u2', 'Bob', { suppressed: true })],
      missing: [],
      excluded: [excluded('u4', 'Dee', 'excluded'), excluded('u5', 'Eve', 'noServer')],
    });
    expect(
      [out.receive, out.suppressed, out.excluded, out.notIncludable].map((rows) =>
        rows.map((r) => r.userId)
      )
    ).toEqual([['u1'], ['u2'], ['u4'], ['u5']]);
  });
});

describe('pendingChange', () => {
  it('names only what differs from the saved exclusions', () => {
    expect(pendingChange('u1', ['u1'], [])).toBe('excluded');
    expect(pendingChange('u1', [], ['u1'])).toBe('included');
    expect(pendingChange('u1', ['u1'], ['u1'])).toBeNull();
    expect(pendingChange(null, [], ['u1'])).toBeNull();
  });
});

describe('summaryEntries', () => {
  it('lists a person once whatever brings them up, and stops at the cap', () => {
    const ann = member('u1', 'Ann', { newSinceLastSend: true });
    const once = summaryEntries(
      partitionRecipients({ recipients: [ann], missing: [], excluded: [] }),
      () => 'included'
    );
    expect(once.map((row) => row.key)).toEqual(['u1']);

    const crowd = Array.from({ length: 12 }, (_, i) =>
      member(`n${i}`, `New${i}`, { newSinceLastSend: true })
    );
    expect(
      summaryEntries(
        partitionRecipients({ recipients: crowd, missing: [], excluded: [] }),
        () => null
      )
    ).toHaveLength(SUMMARY_ROWS);
  });
});

describe('matchesSearch and entryOnServer', () => {
  it('matches name, username and address in any case, and puts an extra address on every server', () => {
    const ann = recipientEntry(member('u1', 'Ann', { serverIds: ['s2'] }));
    const guest = recipientEntry({
      ...member('x', 'x'),
      userId: null,
      serverUserId: null,
      name: null,
      username: null,
      address: 'Guest@Home.org',
      serverIds: [],
    });
    expect(matchesSearch(ann, 'ANN@')).toBe(true);
    expect(matchesSearch(ann, 'zed')).toBe(false);
    expect(matchesSearch(guest, 'home.org')).toBe(true);
    expect(matchesSearch(excludedEntry(excluded('u4', 'Dee', 'banned')), 'dee')).toBe(true);
    expect(entryOnServer(ann, 's2', ['s1', 's2'])).toBe(true);
    expect(entryOnServer(ann, 's1', ['s1', 's2'])).toBe(false);
    expect(entryOnServer(guest, 's1', ['s1', 's2'])).toBe(true);
  });
});

describe('groupByVariant', () => {
  it('puts each row under the scoped servers it belongs to, extras under the union, union first', () => {
    const rows = [
      { userId: 'u1', serverIds: ['s1'] },
      { userId: null, serverIds: [] },
      { userId: 'u2', serverIds: ['s2', 's1'] },
      { userId: 'u3', serverIds: ['s2'] },
    ];
    const groups = groupByVariant(rows, [
      { id: 's2', name: 'Attic' },
      { id: 's1', name: 'Home Plex' },
    ]);
    expect(groups.map((g) => [g.key, g.serverNames, g.rows.map((r) => r.userId)])).toEqual([
      ['s1,s2', ['Attic', 'Home Plex'], [null, 'u2']],
      ['s1', ['Home Plex'], ['u1']],
      ['s2', ['Attic'], ['u3']],
    ]);
  });
});
