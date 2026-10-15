/**
 * Member library access
 *
 * A member's account can be limited to some of a server's libraries. Their scope carries the
 * limit from server_users.library_ids, and the browse queries narrow by it, so only a real
 * database can say the uuid and text comparisons hold.
 *
 * Run with: pnpm --filter @tracearr/server test:integration memberLibraryAccess
 */

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createTestLibraryItem,
  createTestServer,
  createTestServerUser,
  createTestUser,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { media, serverUsers } from '../../src/db/schema.js';
import { ownScope } from '../../src/lib/scope.js';
import { buildCatalogPageQuery } from '../../src/routes/library/catalog.js';
import { hiddenByLibraryLimit } from '../../src/services/library/mediaDetailService.js';

async function addMedia(title: string): Promise<string> {
  const [row] = await db
    .insert(media)
    .values({
      mediaType: 'movie',
      matchKey: `movie:title:${title.toLowerCase()}:2020`,
      title,
      normalizedTitle: title.toLowerCase(),
      year: 2020,
    })
    .returning({ id: media.id });
  return row!.id;
}

async function addMovie(serverId: string, libraryId: string, title: string): Promise<string> {
  const mediaId = await addMedia(title);
  await createTestLibraryItem({ serverId, libraryId, title, mediaId });
  return mediaId;
}

async function account(userId: string, serverId: string, libraryIds: string[] | null) {
  const created = await createTestServerUser({ userId, serverId });
  await db.update(serverUsers).set({ libraryIds }).where(eq(serverUsers.id, created.id));
}

describe('member library access', () => {
  it('shows a member only titles from libraries each account can open', async () => {
    const limited = await createTestServer();
    const open = await createTestServer();
    const none = await createTestServer();
    const user = await createTestUser();
    await account(user.id, limited.id, ['movies']);
    await account(user.id, open.id, null);
    await account(user.id, none.id, []);
    const heat = await addMovie(limited.id, 'movies', 'Heat');
    const bluey = await addMovie(limited.id, 'kids', 'Bluey');
    const uncopied = await addMedia('Tenet');
    await addMovie(open.id, 'kids', 'Ronin');
    await addMovie(none.id, 'movies', 'Up');

    const scope = await ownScope(user.id, 'all');
    const result = await db.execute(
      buildCatalogPageQuery({
        type: 'movie',
        sort: 'title',
        offset: 0,
        genre: null,
        yearFrom: null,
        yearTo: null,
        searchNormalized: null,
        resolution: null,
        libraryServerId: null,
        libraryId: null,
        hdr: false,
        atmos: false,
        sizeGbMin: null,
        sizeGbMax: null,
        serverIds: scope.serverIds,
        scope,
        pageSize: 50,
      })
    );

    expect((result.rows as { title: string }[]).map((row) => row.title).sort()).toEqual([
      'Heat',
      'Ronin',
    ]);
    expect(await hiddenByLibraryLimit(bluey, scope.serverIds, scope)).toBe(true);
    expect(await hiddenByLibraryLimit(heat, scope.serverIds, scope)).toBe(false);
    expect(await hiddenByLibraryLimit(uncopied, scope.serverIds, scope)).toBe(false);
    expect(await hiddenByLibraryLimit(bluey, undefined, 'all')).toBe(false);
  });
});
