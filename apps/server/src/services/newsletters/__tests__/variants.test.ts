import { describe, expect, it } from 'vitest';
import type { ResolvedRecipient } from '../recipients.js';
import type { ServerLink } from '../store.js';
import {
  orderServers,
  planVariants,
  testVariantPlan,
  variantScope,
  variantSenderName,
} from '../variants.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const link = (id: string, name: string): ServerLink => ({
  id,
  name,
  type: 'plex',
  url: 'http://plex',
  publicUrl: null,
  machineIdentifier: null,
});
const attic = link(A, 'Attic');
const basement = link(B, 'Basement');
const member = (address: string, serverIds: string[]): ResolvedRecipient => ({
  address,
  userId: `u-${address}`,
  serverUserId: `su-${address}`,
  name: null,
  suppressed: false,
  serverId: serverIds[0] ?? '',
  serverIds,
  username: null,
  serverName: '',
  thumbUrl: null,
});
const extra = (address: string): ResolvedRecipient => ({
  ...member(address, []),
  userId: null,
  serverUserId: null,
  serverId: null,
  serverName: null,
});

describe('orderServers', () => {
  it('follows the scope list, and keeps name order when the scope names none', () => {
    expect(orderServers({ serverIds: [B, A] }, [attic, basement]).map((s) => s.name)).toEqual([
      'Basement',
      'Attic',
    ]);
    expect(orderServers({ serverIds: [] }, [attic, basement]).map((s) => s.name)).toEqual([
      'Attic',
      'Basement',
    ]);
  });
});

describe('planVariants', () => {
  it('groups members by the scoped servers they belong to, puts extras in the union, and sets aside a member on no scoped server', () => {
    const plan = planVariants([attic, basement], {
      recipients: [
        member('ann@x.com', [A]),
        member('bob@x.com', [B]),
        member('cid@x.com', [B, A]),
        extra('extra@x.com'),
        member('dave@x.com', ['33333333-3333-4333-8333-333333333333']),
      ],
      missing: [],
      excluded: [],
    });
    expect(
      plan.variants.map((v) => [v.key, v.serverNames, v.recipients.map((r) => r.address)])
    ).toEqual([
      [`${A},${B}`, ['Attic', 'Basement'], ['cid@x.com', 'extra@x.com']],
      [A, ['Attic'], ['ann@x.com']],
      [B, ['Basement'], ['bob@x.com']],
    ]);
    expect(plan.excluded.map((p) => [p.userId, p.reason])).toEqual([['u-dave@x.com', 'noServer']]);
  });

  it('always lists the union first, even with nobody in it', () => {
    const plan = planVariants([attic, basement], {
      recipients: [member('ann@x.com', [A])],
      missing: [],
      excluded: [],
    });
    expect(plan.variants.map((v) => [v.key, v.recipients.length])).toEqual([
      [`${A},${B}`, 0],
      [A, 1],
    ]);
  });
});

describe('testVariantPlan', () => {
  it('is one lowercased address on the union, or on the variant the owner picked', () => {
    const union = testVariantPlan([attic, basement], ' Me@Example.com ', undefined);
    expect(union.variants.map((v) => [v.key, v.recipients.map((r) => r.address)])).toEqual([
      [`${A},${B}`, ['me@example.com']],
    ]);
    const picked = testVariantPlan([attic, basement], 'me@example.com', B);
    expect(picked.variants.map((v) => [v.key, v.serverNames])).toEqual([[B, ['Basement']]]);
  });
});

describe('variantScope', () => {
  it('is null for a variant on no server, so a scope whose servers are all gone assembles nothing', () => {
    expect(variantScope({ serverIds: [A], libraries: [] }, [])).toBeNull();
    expect(
      variantScope({ serverIds: [A], libraries: [{ serverId: A, libraryId: '1' }] }, [])
    ).toBeNull();
  });

  it('keeps only the pairs on the variant servers, and is null when the newsletter has pairs but none there', () => {
    const scope = { serverIds: [], libraries: [{ serverId: A, libraryId: '1' }] };
    expect(variantScope(scope, [A, B])).toEqual({
      serverIds: [A, B],
      libraries: [{ serverId: A, libraryId: '1' }],
    });
    expect(variantScope(scope, [B])).toBeNull();
    expect(variantScope({ serverIds: [A], libraries: [] }, [A])).toEqual({
      serverIds: [A],
      libraries: [],
    });
  });
});

describe('variantSenderName', () => {
  it('uses the newsletter name, else the one server, else Tracearr', () => {
    expect(variantSenderName({ id: 'n1', senderName: 'Family' }, ['Attic', 'Basement'])).toBe(
      'Family'
    );
    expect(variantSenderName({ id: 'n1', senderName: null }, ['Attic'])).toBe('Attic');
    expect(variantSenderName({ id: 'n1', senderName: null }, ['Attic', 'Basement'])).toBe(
      'Tracearr'
    );
  });
});
