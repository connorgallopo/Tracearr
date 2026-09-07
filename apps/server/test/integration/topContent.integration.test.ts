/**
 * topWatched used to pick server_id, rating_key, and thumb_path with three
 * independent MAX()s alongside the play count, so a title streamed on two
 * servers could mix identity columns from different sessions and point Task
 * 7's deep link at the wrong server. This proves the fix: those three columns
 * now come from one row, the title's most recent session inside the window.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- topContent
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { seedBasicOwner } from '@tracearr/test-utils';
import {
  buildSession,
  createTestServer,
  createTestServerUser,
  createTestUser,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { libraryItems, sessions } from '../../src/db/schema.js';
import { topWatched } from '../../src/services/stats/topContent.js';

const START = new Date('2026-08-26T00:00:00Z');
const END = new Date('2026-09-02T00:00:00Z');
const older = new Date('2026-08-28T00:00:00Z');
const newer = new Date('2026-08-30T00:00:00Z');

describe('topWatched', () => {
  let serverAId: string;
  let serverBId: string;

  beforeEach(async () => {
    const ownerA = await seedBasicOwner();
    serverAId = ownerA.serverId;

    const serverB = await createTestServer({ type: 'jellyfin' });
    const userB = await createTestUser();
    const serverUserB = await createTestServerUser({ serverId: serverB.id, userId: userB.id });
    serverBId = serverB.id;

    await db.insert(sessions).values([
      // Older play of the shared title, on server A.
      buildSession({
        serverId: serverAId,
        serverUserId: ownerA.serverUserId,
        mediaTitle: 'Shared Movie',
        ratingKey: 'a-1',
        thumbPath: '/thumb/a-1',
        startedAt: older,
        lastSeenAt: older,
      }),
      // Newer play of the same title, on server B: this session should win
      // the identity columns, not an independent MAX() per column.
      buildSession({
        serverId: serverBId,
        serverUserId: serverUserB.id,
        mediaTitle: 'Shared Movie',
        ratingKey: 'b-9',
        thumbPath: '/thumb/b-9',
        startedAt: newer,
        lastSeenAt: newer,
      }),
      // A second movie, only ever played on server A.
      buildSession({
        serverId: serverAId,
        serverUserId: ownerA.serverUserId,
        mediaTitle: 'Solo Movie',
        ratingKey: 'a-2',
        thumbPath: '/thumb/a-2',
        startedAt: older,
        lastSeenAt: older,
      }),
    ]);
  });

  it('takes server_id, rating_key, and thumb_path from the most recent session in scope', async () => {
    const { movies } = await topWatched({
      start: START,
      end: END,
      serverIds: [],
      libraries: [],
      limit: 10,
    });
    expect(movies).toHaveLength(2);
    expect(movies[0]).toMatchObject({
      title: 'Shared Movie',
      plays: 2,
      serverId: serverBId,
      ratingKey: 'b-9',
      thumbPath: '/thumb/b-9',
    });
    expect(movies[1]).toMatchObject({
      title: 'Solo Movie',
      plays: 1,
      serverId: serverAId,
      ratingKey: 'a-2',
    });
  });

  it('applies server scope to both the play count and the identity columns', async () => {
    const { movies } = await topWatched({
      start: START,
      end: END,
      serverIds: [serverAId],
      libraries: [],
      limit: 10,
    });
    expect(movies).toHaveLength(2);
    expect(movies.every((m) => m.serverId === serverAId)).toBe(true);
    const shared = movies.find((m) => m.title === 'Shared Movie');
    expect(shared).toMatchObject({ plays: 1, serverId: serverAId, ratingKey: 'a-1' });
  });

  it('scopes plays by the server and library pair, not the bare library id', async () => {
    await db.insert(libraryItems).values([
      {
        serverId: serverAId,
        libraryId: '1',
        ratingKey: 'a-1',
        title: 'Shared Movie',
        mediaType: 'movie',
      },
      {
        serverId: serverBId,
        libraryId: '1',
        ratingKey: 'b-9',
        title: 'Shared Movie',
        mediaType: 'movie',
      },
    ]);
    const { movies } = await topWatched({
      start: START,
      end: END,
      serverIds: [],
      libraries: [{ serverId: serverBId, libraryId: '1' }],
      limit: 10,
    });
    expect(movies).toEqual([
      expect.objectContaining({
        title: 'Shared Movie',
        plays: 1,
        serverId: serverBId,
        ratingKey: 'b-9',
      }),
    ]);
  });
});
