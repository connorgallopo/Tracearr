/**
 * Agregarr's coming-soon placeholders through a library sync on real Postgres: the
 * trailer movie and S00E00 episode are never stored, a show or season that holds only
 * the placeholder goes with it and is never announced, and migration 0125 clears the rows
 * stored before.
 *
 * Run with: pnpm --filter @tracearr/server test:integration librarySyncPlaceholders
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestServer } from '@tracearr/test-utils/factories';
import { executeRawSql } from '@tracearr/test-utils/db';
import { db } from '../../src/db/client.js';
import { libraryItems } from '../../src/db/schema.js';
import {
  createMediaServerClient,
  type MediaLibraryItem,
} from '../../src/services/mediaServer/index.js';
import { librarySyncService } from '../../src/services/librarySync.js';
import { dispatchMediaAdded } from '../../src/services/automations/events/producers.js';

vi.mock('../../src/services/mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

vi.mock('../../src/services/automations/events/producers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/automations/events/producers.js')>()),
  mediaListeners: vi.fn().mockResolvedValue({ added: true, upgraded: true }),
  dispatchMediaAdded: vi.fn(),
}));

const ADDED_AT = new Date('2026-10-20T12:00:00Z');
const TRAILER_MOVIE = '/movies/Dune (2026)/Dune (2026) {tmdb-1} {edition-Trailer}.mp4';
const LEGACY_TRAILER = '/tv/Severance (2022)/Season 00/S00E00.Trailer.mp4';
const EDITION_TRAILER = '/tv/Nocturne (2026) {edition-Trailer}/Season 00/S00E00.Trailer.mp4';

function item(
  overrides: Partial<MediaLibraryItem> & Pick<MediaLibraryItem, 'ratingKey'>
): MediaLibraryItem {
  return { title: overrides.ratingKey, mediaType: 'movie', addedAt: ADDED_AT, ...overrides };
}

function episode(ratingKey: string, show: string, season: string, filePath: string) {
  return item({
    ratingKey,
    mediaType: 'episode',
    grandparentRatingKey: show,
    parentRatingKey: season,
    filePath,
  });
}

function page(items: MediaLibraryItem[], options?: { offset?: number }) {
  return Promise.resolve({
    items: (options?.offset ?? 0) === 0 ? items : [],
    totalCount: items.length,
  });
}

function stubPlexClient(library: {
  type: string;
  items: MediaLibraryItem[];
  leaves?: MediaLibraryItem[];
  seasons?: MediaLibraryItem[];
}) {
  vi.mocked(createMediaServerClient).mockReturnValue({
    serverType: 'plex',
    testConnection: () => Promise.resolve(true),
    getLibraries: () => Promise.resolve([{ id: 'lib', name: 'Library', type: library.type }]),
    getLibraryItems: (_id: string, options?: { offset?: number }) => page(library.items, options),
    getLibraryLeaves: (_id: string, options?: { offset?: number }) =>
      page(library.leaves ?? [], options),
    getLibrarySeasons: (_id: string, options?: { offset?: number }) =>
      page(library.seasons ?? [], options),
  } as never);
}

async function storedKeys(serverId: string): Promise<string[]> {
  const rows = await db
    .select({ ratingKey: libraryItems.ratingKey })
    .from(libraryItems)
    .where(eq(libraryItems.serverId, serverId));
  return rows.map((row) => row.ratingKey).sort();
}

describe('library sync coming-soon placeholders', () => {
  it('stores the real movie and skips the trailer edition', async () => {
    const server = await createTestServer({ type: 'plex' });
    stubPlexClient({
      type: 'movie',
      items: [
        item({ ratingKey: 'dune', filePath: '/movies/Dune (2026)/Dune (2026).mkv' }),
        item({ ratingKey: 'dune-trailer', filePath: TRAILER_MOVIE }),
      ],
    });

    await librarySyncService.syncServer(server.id, undefined, 'manual');

    expect(await storedKeys(server.id)).toEqual(['dune']);
  });

  it('drops a show or season that holds only the placeholder and keeps the real show', async () => {
    const server = await createTestServer({ type: 'plex' });
    stubPlexClient({
      type: 'show',
      items: [
        item({ ratingKey: 'severance', mediaType: 'show' }),
        item({ ratingKey: 'nocturne', mediaType: 'show' }),
      ],
      leaves: [
        episode('sev-e1', 'severance', 'sev-s1', '/tv/Severance (2022)/Season 01/S01E01.mkv'),
        episode('sev-trailer', 'severance', 'sev-s0', LEGACY_TRAILER),
        episode('noc-trailer', 'nocturne', 'noc-s0', EDITION_TRAILER),
      ],
      seasons: [
        item({ ratingKey: 'sev-s1', mediaType: 'season', parentRatingKey: 'severance' }),
        item({ ratingKey: 'sev-s0', mediaType: 'season', parentRatingKey: 'severance' }),
        item({ ratingKey: 'noc-s0', mediaType: 'season', parentRatingKey: 'nocturne' }),
      ],
    });

    await librarySyncService.syncServer(server.id, undefined, 'manual');

    expect(await storedKeys(server.id)).toEqual(['sev-e1', 'sev-s1', 'severance']);
  });

  it('announces the real arrival and never the placeholder show or its season', async () => {
    const server = await createTestServer({ type: 'plex' });
    const severance = item({ ratingKey: 'severance', mediaType: 'show' });
    const sevS1 = item({ ratingKey: 'sev-s1', mediaType: 'season', parentRatingKey: 'severance' });
    const sevE1 = episode('sev-e1', 'severance', 'sev-s1', '/tv/Severance/Season 01/S01E01.mkv');
    stubPlexClient({ type: 'show', items: [severance], leaves: [sevE1], seasons: [sevS1] });
    await librarySyncService.syncServer(server.id, undefined, 'manual');
    vi.mocked(dispatchMediaAdded).mockClear();

    stubPlexClient({
      type: 'show',
      items: [severance, item({ ratingKey: 'nocturne', mediaType: 'show' })],
      leaves: [
        sevE1,
        episode('sev-e2', 'severance', 'sev-s1', '/tv/Severance/Season 01/S01E02.mkv'),
        episode('noc-trailer', 'nocturne', 'noc-s0', EDITION_TRAILER),
      ],
      seasons: [
        sevS1,
        item({ ratingKey: 'noc-s0', mediaType: 'season', parentRatingKey: 'nocturne' }),
      ],
    });
    await librarySyncService.syncServer(server.id, undefined, 'manual');

    const announced = vi
      .mocked(dispatchMediaAdded)
      .mock.calls.map(([args]) => args.media.ratingKey);
    expect(announced).toEqual(['sev-e2']);
  });

  it('migration 0125 clears stored placeholders and the shows and seasons they alone held', async () => {
    const server = await createTestServer({ type: 'plex' });
    const row = (key: string, type: string, path: string | null, show?: string, season?: string) =>
      `('${server.id}', 'lib', '${key}', '${key}', '${type}', ${path ? `'${path}'` : 'NULL'}, ` +
      `${show ? `'${show}'` : 'NULL'}, ${season ? `'${season}'` : 'NULL'})`;
    await executeRawSql(`
      INSERT INTO library_items
        (server_id, library_id, rating_key, title, media_type, file_path,
         grandparent_rating_key, parent_rating_key)
      VALUES
        ${row('dune', 'movie', '/movies/Dune (2026)/Dune (2026).mkv')},
        ${row('dune-trailer', 'movie', TRAILER_MOVIE)},
        ${row('severance', 'show', null)},
        ${row('sev-s1', 'season', null, undefined, 'severance')},
        ${row('sev-s0', 'season', null, undefined, 'severance')},
        ${row('sev-e1', 'episode', '/tv/Severance (2022)/Season 01/S01E01.mkv', 'severance', 'sev-s1')},
        ${row('sev-trailer', 'episode', LEGACY_TRAILER, 'severance', 'sev-s0')},
        ${row('nocturne', 'show', null)},
        ${row('noc-s0', 'season', null, undefined, 'nocturne')},
        ${row('noc-trailer', 'episode', EDITION_TRAILER, 'nocturne', 'noc-s0')}
    `);
    await executeRawSql(
      `UPDATE library_items SET removed_at = now() WHERE server_id = '${server.id}' AND rating_key = 'dune-trailer'`
    );
    await executeRawSql(
      `UPDATE library_items SET replaces_library_item_id =
         (SELECT id FROM library_items WHERE server_id = '${server.id}' AND rating_key = 'dune-trailer')
       WHERE server_id = '${server.id}' AND rating_key = 'dune'`
    );

    await executeRawSql(
      readFileSync(
        new URL('../../src/db/migrations/0125_drop_coming_soon_placeholders.sql', import.meta.url),
        'utf8'
      )
    );

    expect(await storedKeys(server.id)).toEqual(['dune', 'sev-e1', 'sev-s1', 'severance']);
    const [dune] = await db
      .select({ replaces: libraryItems.replacesLibraryItemId })
      .from(libraryItems)
      .where(eq(libraryItems.ratingKey, 'dune'));
    expect(dune?.replaces).toBeNull();
  });
});
