import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: { select: vi.fn() } }));
vi.mock('../../lib/memberLogin.js', () => ({ upsertTofaAccount: vi.fn() }));
vi.mock('../../lib/revoke.js', () => ({ revokeOtherWebSessions: vi.fn() }));
vi.mock('../mergeService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mergeService.js')>()),
  mergeUsers: vi.fn(),
  splitServerUser: vi.fn(),
}));

import { db } from '../../db/client.js';
import { MergeValidationError, mergeUsers } from '../mergeService.js';
import { getOwnerLinks, linkOwnerAccount, linkOwnerSiloAccount } from '../ownerAccountLink.js';

const OWNER_ID = 'owner-1';
const SERVER_ID = 'silo-server-1';
const PERSON_ID = 'person-1';

// Each db.select() resolves the next queued row set, in call order.
function queueSelects(...results: unknown[][]) {
  for (const rows of results) {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
    };
    vi.mocked(db.select).mockReturnValueOnce(chain as never);
  }
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('linkOwnerSiloAccount', () => {
  it("merges the approver's account into the owner", async () => {
    queueSelects(
      [{ userId: PERSON_ID, serverId: SERVER_ID }],
      [{ personAccounts: 1, ownerAccountsHere: 0 }]
    );

    await linkOwnerSiloAccount(OWNER_ID, SERVER_ID, 'silo-user-1');

    expect(mergeUsers).toHaveBeenCalledExactlyOnceWith(PERSON_ID, OWNER_ID, OWNER_ID);
  });

  it('refuses an approver with no live account on the server', async () => {
    queueSelects([]);

    await expect(linkOwnerSiloAccount(OWNER_ID, SERVER_ID, 'silo-user-9')).rejects.toThrow(
      new MergeValidationError(
        'The Silo account that approved the code has no account on this server'
      )
    );
    expect(mergeUsers).not.toHaveBeenCalled();
  });

  it("changes nothing for the owner's own account", async () => {
    queueSelects([{ userId: OWNER_ID, serverId: SERVER_ID }]);

    await linkOwnerSiloAccount(OWNER_ID, SERVER_ID, 'silo-user-1');

    expect(mergeUsers).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('refuses a person holding accounts on other servers', async () => {
    queueSelects(
      [{ userId: PERSON_ID, serverId: SERVER_ID }],
      [{ personAccounts: 2, ownerAccountsHere: 0 }]
    );

    await expect(linkOwnerSiloAccount(OWNER_ID, SERVER_ID, 'silo-user-1')).rejects.toThrow(
      'This person has accounts on other servers too. Split this account off on their page first.'
    );
    expect(mergeUsers).not.toHaveBeenCalled();
  });
});

describe('getOwnerLinks', () => {
  it('lists a Silo server with no accounts to pick from', async () => {
    queueSelects(
      [{ id: SERVER_ID, type: 'silo' }],
      [
        {
          id: 'su-1',
          serverId: SERVER_ID,
          userId: PERSON_ID,
          username: 'connor',
          removedAt: null,
          role: 'member',
          accountCount: 1,
        },
      ]
    );

    expect(await getOwnerLinks(OWNER_ID)).toEqual([
      { serverId: SERVER_ID, linked: null, candidates: [] },
    ]);
  });
});

describe('linkOwnerAccount', () => {
  it('refuses a Silo account', async () => {
    queueSelects([{ userId: PERSON_ID, serverId: SERVER_ID, removedAt: null, type: 'silo' }]);

    await expect(linkOwnerAccount(OWNER_ID, 'su-1')).rejects.toThrow(MergeValidationError);
    expect(mergeUsers).not.toHaveBeenCalled();
  });
});
