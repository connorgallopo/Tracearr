/**
 * tofa's library sync on real Postgres and Redis: a full scan stores the change revision it
 * started from, the next sync applies tofa's changes after it, deletions included, and a
 * revision tofa no longer holds changes for sends the library back to a full scan.
 *
 * Run with: pnpm --filter @tracearr/server test:integration librarySyncTofaRevision
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { REDIS_KEYS } from '@tracearr/shared';
import { createTestServer } from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { libraryItems } from '../../src/db/schema.js';
import { createMediaServerClient } from '../../src/services/mediaServer/index.js';
import {
  FullSyncRequiredError,
  type IMediaServerClient,
  type LibraryChangeFeed,
  type MediaLibraryItem,
} from '../../src/services/mediaServer/types.js';
import {
  parseTofaLibraryItem,
  parseTofaShowChildren,
} from '../../src/services/mediaServer/tofa/parser.js';
import { initLibrarySyncRedis, librarySyncService } from '../../src/services/librarySync.js';
import { fakeTofaClient } from '../../src/test/mediaServerFakes.js';
import tofa from '../../src/test/mediaServerResponses/tofa.json' with { type: 'json' };

vi.mock('../../src/services/mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

vi.mock('../../src/services/automations/events/producers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/automations/events/producers.js')>()),
  mediaListeners: vi.fn().mockResolvedValue({ added: false, upgraded: false }),
}));

const MOVIES = 'e5b8d2f7-1a4c-4e93-b6d0-8f2a5c7e1b46';
const SHOWS = 'f3c6a9e2-7b1d-4f85-9c2a-4e8b1d6f3a72';
const [movie, show] = tofa.mediaBatch;

let redis: Redis;

beforeAll(() => {
  redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380');
  initLibrarySyncRedis(redis);
});

afterAll(async () => {
  await redis.quit();
});

function changes(feed: Partial<LibraryChangeFeed>, items: MediaLibraryItem[] = []) {
  return {
    items,
    totalCount: feed.wholeIds?.length ?? 0,
    feed: { deletedIds: [], wholeIds: [], revision: 125, ...feed },
  };
}

async function activeKeys(serverId: string): Promise<string[]> {
  const rows = await db
    .select({ ratingKey: libraryItems.ratingKey })
    .from(libraryItems)
    .where(and(eq(libraryItems.serverId, serverId), isNull(libraryItems.removedAt)));
  return rows.map((row) => row.ratingKey).sort();
}

/** A server whose first, full sync has run and stored revision 120 */
async function syncedServer(): Promise<{ server: { id: string }; client: IMediaServerClient }> {
  const server = await createTestServer({ type: 'tofa' });
  const client = fakeTofaClient({ getLibraryRevision: vi.fn().mockResolvedValue(120) });
  vi.mocked(createMediaServerClient).mockReturnValue(client);
  await librarySyncService.syncServer(server.id);
  return { server, client };
}

describe('tofa library sync by revision', () => {
  it('stores the revision a full scan started from', async () => {
    const { server } = await syncedServer();

    expect(await redis.get(REDIS_KEYS.LIBRARY_SYNC_REVISION(server.id, SHOWS))).toBe('120');
    expect(await activeKeys(server.id)).toHaveLength(6);
  });

  it('applies the changes after it, removing a deleted movie and the episode a show lost', async () => {
    const { server, client } = await syncedServer();
    if (!show || !movie) throw new Error('fixture lacks a show and a movie');
    const [lostFile, keptFile] = show.files;
    const shrunk = { ...show, files: keptFile ? [keptFile] : [] };
    const { seasons, episodes } = parseTofaShowChildren(shrunk);
    const byLibrary: Record<string, ReturnType<typeof changes>> = {
      [MOVIES]: changes({ deletedIds: [movie.id] }),
      [SHOWS]: changes({ wholeIds: [show.id] }, [
        parseTofaLibraryItem(shrunk),
        ...seasons,
        ...episodes,
      ]),
    };
    vi.mocked(client.getLibraryItemsSince).mockImplementation(
      async (libraryId) => byLibrary[libraryId] ?? changes({})
    );
    vi.mocked(client.getLibraryItems).mockClear();

    await librarySyncService.syncServer(server.id);

    expect(client.getLibraryItemsSince).toHaveBeenCalledWith(
      SHOWS,
      { kind: 'revision', since: 120 },
      { libraryType: 'show' }
    );
    const active = await activeKeys(server.id);
    expect(active).not.toContain(movie.id);
    expect(active).not.toContain(lostFile?.episode_id);
    expect(active).toContain(keptFile?.episode_id);
    expect(active).toContain(show.id);
    expect(active).toHaveLength(3);
    expect(await redis.get(REDIS_KEYS.LIBRARY_SYNC_REVISION(server.id, SHOWS))).toBe('125');
    for (const [, options] of vi.mocked(client.getLibraryItems).mock.calls) {
      expect(options).toMatchObject({ offset: 0, limit: 1 });
    }
  });

  it('keeps the seasons and episodes of a show the library holds twice when one copy changes', async () => {
    if (!show) throw new Error('fixture lacks a show');
    const copy = {
      ...show,
      id: `${show.id}-copy`,
      seasons: show.seasons.map((season) => ({
        ...season,
        id: `${season.id}-copy`,
        episodes: season.episodes.map((episode) => ({ ...episode, id: `${episode.id}-copy` })),
      })),
      files: show.files.map((file) => ({
        ...file,
        id: `${file.id}-copy`,
        episode_id: `${file.episode_id}-copy`,
      })),
    };
    const shows = [show, copy];
    const fixture = fakeTofaClient();
    const server = await createTestServer({ type: 'tofa' });
    const client = fakeTofaClient({
      getLibraryRevision: vi.fn().mockResolvedValue(120),
      getLibraryItems: vi.fn(async (libraryId, paging) => {
        if (libraryId !== SHOWS) return fixture.getLibraryItems(libraryId, paging);
        const page = shows.slice(
          paging?.offset ?? 0,
          (paging?.offset ?? 0) + (paging?.limit ?? 200)
        );
        return { items: page.map(parseTofaLibraryItem), totalCount: 2, rawCount: page.length };
      }),
      getLibraryLeaves: vi.fn(async (libraryId, paging) => {
        if (libraryId !== SHOWS) return fixture.getLibraryLeaves(libraryId, paging);
        const leaves = shows.flatMap((detail) => {
          const { seasons, episodes } = parseTofaShowChildren(detail);
          return [...seasons, ...episodes];
        });
        const page = leaves.slice(
          paging?.offset ?? 0,
          (paging?.offset ?? 0) + (paging?.limit ?? 200)
        );
        return { items: page, totalCount: leaves.length, rawCount: page.length };
      }),
      findExistingRatingKeys: vi.fn(
        async (ratingKeys) =>
          new Set(ratingKeys.filter((key) => key === show.id || key === copy.id))
      ),
    });
    vi.mocked(createMediaServerClient).mockReturnValue(client);
    await librarySyncService.syncServer(server.id);
    const afterFullScan = await activeKeys(server.id);
    expect(afterFullScan).toHaveLength(11);

    const { seasons, episodes } = parseTofaShowChildren(show);
    vi.mocked(client.getLibraryItemsSince).mockImplementation(async (libraryId) =>
      libraryId === SHOWS
        ? changes({ wholeIds: [show.id] }, [parseTofaLibraryItem(show), ...seasons, ...episodes])
        : changes({})
    );
    await librarySyncService.syncServer(server.id);

    expect(client.getLibraryItemsSince).toHaveBeenCalled();
    expect(await activeKeys(server.id)).toEqual(afterFullScan);
  });

  it('runs a full scan, deleting nothing, when tofa no longer holds the changes', async () => {
    const { server, client } = await syncedServer();
    vi.mocked(client.getLibraryItemsSince).mockRejectedValue(
      new FullSyncRequiredError('tofa no longer holds every library change since revision 120')
    );
    vi.mocked(client.getLibraryRevision).mockResolvedValue(130);
    vi.mocked(client.getLibraryItems).mockClear();

    await librarySyncService.syncServer(server.id);

    expect(vi.mocked(client.getLibraryItems).mock.calls.some(([, o]) => o?.limit !== 1)).toBe(true);
    expect(await activeKeys(server.id)).toHaveLength(6);
    expect(await redis.get(REDIS_KEYS.LIBRARY_SYNC_REVISION(server.id, SHOWS))).toBe('130');
  });
});
