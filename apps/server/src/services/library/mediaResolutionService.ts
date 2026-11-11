import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { media, libraryItems } from '../../db/schema.js';
import {
  buildMediaMatchKey,
  buildSortTitle,
  normalizeTitle,
  type MatchKeyInput,
} from './mediaMatchKey.js';

type MediaRow = typeof media.$inferSelect;
type Executor = Pick<typeof db, 'select' | 'update' | 'insert' | 'execute'>;

// Every choice between duplicate rows sorts here, in SQL: a JS Date drops created_at's
// microseconds. Rows from one batch insert share created_at and went in sorted by match key;
// ids are random, so a tie broken on id picks a different row for the same input in another
// database. The C collation keeps the order independent of the database's collation.
const OLDEST_FIRST_SQL = 'created_at, match_key COLLATE "C"';

function lockKeyFor(input: MatchKeyInput): string {
  // Must mirror buildMediaMatchKey's per-type ID precedence, or two servers
  // resolving the same episode can take different locks
  if (input.mediaType === 'episode') {
    if (input.tvdbId) return `episode:tvdb:${input.tvdbId}`;
    if (input.imdbId) return `episode:imdb:${input.imdbId}`;
    if (input.tmdbId) return `episode:tmdb:${input.tmdbId}`;
  } else {
    if (input.imdbId) return `${input.mediaType}:imdb:${input.imdbId}`;
    if (input.tmdbId) return `${input.mediaType}:tmdb:${input.tmdbId}`;
    if (input.tvdbId) return `${input.mediaType}:tvdb:${input.tvdbId}`;
  }
  return buildMediaMatchKey(input);
}

async function findByAnyProviderId(dbc: Executor, input: MatchKeyInput): Promise<MediaRow[]> {
  const conds = [];
  if (input.imdbId) conds.push(eq(media.imdbId, input.imdbId));
  if (input.tmdbId) conds.push(eq(media.tmdbId, input.tmdbId));
  if (input.tvdbId) conds.push(eq(media.tvdbId, input.tvdbId));
  if (conds.length === 0) return [];
  return dbc
    .select()
    .from(media)
    .where(and(eq(media.mediaType, input.mediaType), isNull(media.mergedIntoId), or(...conds)))
    .orderBy(sql.raw(OLDEST_FIRST_SQL));
}

async function findByTitleTolerant(
  dbc: Executor,
  input: MatchKeyInput
): Promise<MediaRow | undefined> {
  // Episodes/seasons share titles across shows; only movie/show titles identify an item
  if (input.mediaType !== 'movie' && input.mediaType !== 'show') return undefined;
  if (!input.title) return undefined;
  const normalized = normalizeTitle(input.title);
  if (!normalized) return undefined;
  const year = input.year ?? 0;
  // A row without a year (an import that knew only the title) fits any year but yields to a
  // row whose year fits; among those the oldest wins, so coexisting duplicates keep resolving
  // to one row.
  const rows = await dbc
    .select()
    .from(media)
    .where(
      and(
        eq(media.mediaType, input.mediaType),
        eq(media.normalizedTitle, normalized),
        isNull(media.mergedIntoId),
        sql`(${media.year} IS NULL OR ${media.year} BETWEEN ${year - 1} AND ${year + 1})`
      )
    )
    .orderBy(sql`${media.year} IS NULL`, sql.raw(OLDEST_FIRST_SQL))
    .limit(1);
  return rows[0];
}

function providerIdsConflict(
  input: Pick<MatchKeyInput, 'imdbId' | 'tmdbId' | 'tvdbId'>,
  row: Pick<MediaRow, 'imdbId' | 'tmdbId' | 'tvdbId'>
): boolean {
  if (input.imdbId && row.imdbId && input.imdbId !== row.imdbId) return true;
  if (input.tmdbId && row.tmdbId && input.tmdbId !== row.tmdbId) return true;
  if (input.tvdbId && row.tvdbId && input.tvdbId !== row.tvdbId) return true;
  return false;
}

function pickIdBearingTitleCandidate(input: MatchKeyInput, rows: MediaRow[]): MediaRow | undefined {
  if (input.mediaType !== 'movie' && input.mediaType !== 'show') return undefined;
  const normalized = input.title ? normalizeTitle(input.title) : '';
  if (!normalized) return undefined;
  const candidates = rows.filter(
    (r) =>
      r.normalizedTitle === normalized &&
      (input.year == null || r.year == null || r.year === input.year) &&
      !providerIdsConflict(input, r)
  );
  if (candidates.length !== 1) return undefined;
  const chosen = candidates[0]!;
  if (input.year == null || chosen.year == null) {
    console.debug(
      `[mediaResolutionService] title probe accepted media ${chosen.id} ` +
        `(imdb ${chosen.imdbId ?? '-'}, tmdb ${chosen.tmdbId ?? '-'}, tvdb ${chosen.tvdbId ?? '-'}) ` +
        `for input ids (imdb ${input.imdbId ?? '-'}, tmdb ${input.tmdbId ?? '-'}, tvdb ${input.tvdbId ?? '-'}) ` +
        'on a missing year, not an equal one'
    );
  }
  return chosen;
}

async function findByTitleWithProviderIds(
  dbc: Executor,
  input: MatchKeyInput
): Promise<MediaRow | undefined> {
  if (input.mediaType !== 'movie' && input.mediaType !== 'show') return undefined;
  if (!input.title) return undefined;
  const normalized = normalizeTitle(input.title);
  if (!normalized) return undefined;
  const rows = await dbc
    .select()
    .from(media)
    .where(
      and(
        eq(media.mediaType, input.mediaType),
        eq(media.normalizedTitle, normalized),
        isNull(media.mergedIntoId)
      )
    );
  return pickIdBearingTitleCandidate(input, rows);
}

async function backfillProviderIds(
  dbc: Executor,
  row: MediaRow,
  input: MatchKeyInput
): Promise<void> {
  const set: Partial<typeof media.$inferInsert> = {};
  if (input.imdbId && !row.imdbId) set.imdbId = input.imdbId;
  if (input.tmdbId && !row.tmdbId) set.tmdbId = input.tmdbId;
  if (input.tvdbId && !row.tvdbId) set.tvdbId = input.tvdbId;
  if (input.showMediaId && !row.showMediaId) set.showMediaId = input.showMediaId;
  if (Object.keys(set).length === 0) return;
  set.updatedAt = new Date();
  await dbc.update(media).set(set).where(eq(media.id, row.id));
}

async function canonicalRootOf(dbc: Executor, start: MediaRow): Promise<MediaRow> {
  let current = start;
  for (let hops = 0; current.mergedIntoId; hops++) {
    if (hops >= 10) throw new Error(`merge chain too deep at media ${current.id}`);
    const [next] = await dbc
      .select()
      .from(media)
      .where(eq(media.id, current.mergedIntoId))
      .for('update');
    if (!next) throw new Error(`merge chain broken at media ${current.id}`);
    current = next;
  }
  return current;
}

async function mergeMediaRowsWithin(
  dbc: Executor,
  winnerId: string,
  loserId: string
): Promise<void> {
  if (winnerId === loserId) return;
  const [selected] = await dbc.select().from(media).where(eq(media.id, winnerId)).for('update');
  if (!selected) throw new Error('merge winner not found');
  // A concurrent merge may have claimed the winner; land on its canonical root
  const winner = await canonicalRootOf(dbc, selected);
  if (winner.id === loserId) return;
  const [loser] = await dbc.select().from(media).where(eq(media.id, loserId));
  if (loser) {
    const gained: Partial<typeof media.$inferInsert> = {};
    if (loser.imdbId && !winner.imdbId) gained.imdbId = loser.imdbId;
    if (loser.tmdbId && !winner.tmdbId) gained.tmdbId = loser.tmdbId;
    if (loser.tvdbId && !winner.tvdbId) gained.tvdbId = loser.tvdbId;
    if (loser.genres && !winner.genres) gained.genres = loser.genres;
    if (Object.keys(gained).length > 0) {
      gained.updatedAt = new Date();
      await dbc.update(media).set(gained).where(eq(media.id, winner.id));
    }
  }
  await dbc
    .update(media)
    .set({ mergedIntoId: winner.id, updatedAt: new Date() })
    .where(or(eq(media.id, loserId), eq(media.mergedIntoId, loserId)));
  await dbc.update(media).set({ parentMediaId: winner.id }).where(eq(media.parentMediaId, loserId));
  await dbc.update(media).set({ showMediaId: winner.id }).where(eq(media.showMediaId, loserId));
  await dbc.execute(
    sql`UPDATE library_items SET media_id = ${winner.id} WHERE media_id = ${loserId}`
  );
}

export async function mergeMediaRows(winnerId: string, loserId: string): Promise<void> {
  await db.transaction(async (tx) => mergeMediaRowsWithin(tx, winnerId, loserId));
}

/** One-hop canonicalization: a merged-loser id resolves to its winner, anything else to itself. */
export async function canonicalMediaId(mediaId: string): Promise<string> {
  const [row] = await db
    .select({ mergedIntoId: media.mergedIntoId })
    .from(media)
    .where(eq(media.id, mediaId));
  return row?.mergedIntoId ?? mediaId;
}

export async function resolveMediaAliases(mediaId: string): Promise<string[]> {
  const rows = await db
    .select({ id: media.id })
    .from(media)
    .where(or(eq(media.id, mediaId), eq(media.mergedIntoId, mediaId)));
  return rows.map((r) => r.id);
}

function episodeNumberKey(input: MatchKeyInput): string | null {
  return input.mediaType === 'episode' &&
    input.showMediaId &&
    input.seasonNumber != null &&
    input.seasonNumber > 0 &&
    input.episodeNumber != null
    ? `episode:${input.showMediaId}:s${input.seasonNumber}e${input.episodeNumber}`
    : null;
}

/**
 * An episode row keyed by show and number predates the provider ids a later sync brings (an
 * import resolved it before its episode synced). The synced episode adopts that row and
 * backfills the ids, rather than opening a second row for the same episode, under the advisory
 * lock an import takes to insert that row. The adoption is refused when both sides carry an
 * episode title and the titles differ, the one signal that the number is a different ordering
 * of the same show; untitled rows cannot be told apart.
 */
async function adoptNumberKeyedEpisode(
  tx: Executor & { execute: typeof db.execute },
  input: MatchKeyInput
): Promise<MediaRow | undefined> {
  const numberKey = episodeNumberKey(input);
  if (!numberKey || !(input.imdbId || input.tmdbId || input.tvdbId)) return undefined;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${numberKey}))`);
  const [row] = await tx.select().from(media).where(eq(media.matchKey, numberKey));
  const inputTitle = input.title ? normalizeTitle(input.title) : '';
  if (
    !row ||
    row.mergedIntoId ||
    providerIdsConflict(input, row) ||
    (inputTitle && row.normalizedTitle && row.normalizedTitle !== inputTitle)
  ) {
    return undefined;
  }
  await backfillProviderIds(tx, row, input);
  return row;
}

export async function resolveMediaForItem(input: MatchKeyInput): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKeyFor(input)}))`);

    const hits = await findByAnyProviderId(tx, input);
    if (hits.length > 1) {
      // Two rows describe the same item: merge into the oldest
      for (const loser of hits.slice(1)) await mergeMediaRowsWithin(tx, hits[0]!.id, loser.id);
    }
    let hit: MediaRow | undefined = hits[0];
    if (!hit) {
      hit =
        input.imdbId || input.tmdbId || input.tvdbId
          ? await findByTitleWithProviderIds(tx, input)
          : await findByTitleTolerant(tx, input);
    }
    if (hit) {
      await backfillProviderIds(tx, hit, input);
      return hit.id;
    }
    const adopted = await adoptNumberKeyedEpisode(tx, input);
    if (adopted) return adopted.id;

    const matchKey = buildMediaMatchKey(input);
    const normalizedTitle = input.title ? normalizeTitle(input.title) || null : null;
    const inserted = await tx
      .insert(media)
      .values({
        mediaType: input.mediaType,
        matchKey,
        imdbId: input.imdbId ?? null,
        tmdbId: input.tmdbId ?? null,
        tvdbId: input.tvdbId ?? null,
        title: input.title ?? '',
        normalizedTitle,
        sortTitle: buildSortTitle(input.title ?? ''),
        year: input.year ?? null,
        showMediaId: input.showMediaId ?? null,
      })
      .onConflictDoNothing({ target: media.matchKey })
      .returning({ id: media.id });
    if (inserted[0]) return inserted[0].id;
    const [existing] = await tx.select().from(media).where(eq(media.matchKey, matchKey));
    if (!existing) throw new Error(`media resolution failed for ${matchKey}`);
    return (await canonicalRootOf(tx, existing)).id;
  });
}

/**
 * Fallback for episodes whose show wasn't in the same resolution batch (shows
 * and episodes are synced in separate paginated batches, so the in-batch
 * showIdByRatingKey map only ever covers same-batch shows). Looks up each
 * missing show's canonical media id from library_items, which the show's own
 * sync already wrote it to. One query per distinct server present in
 * `missing`, not per item. Shows that genuinely haven't synced yet are simply
 * absent from the result - the caller leaves show_media_id null and a later
 * sync (or backfillProviderIds) repairs it.
 */
async function lookupShowIdsFromLibraryItems(
  missing: Map<string, Set<string>>
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const [serverId, ratingKeys] of missing) {
    if (ratingKeys.size === 0) continue;
    const rows = await db
      .select({ ratingKey: libraryItems.ratingKey, mediaId: libraryItems.mediaId })
      .from(libraryItems)
      .where(
        and(
          eq(libraryItems.serverId, serverId),
          eq(libraryItems.mediaType, 'show'),
          inArray(libraryItems.ratingKey, Array.from(ratingKeys)),
          isNotNull(libraryItems.mediaId)
        )
      );
    for (const row of rows) {
      if (row.mediaId) result.set(`${serverId}:${row.ratingKey}`, row.mediaId);
    }
  }
  return result;
}

/** The subset of a stored library_items row that determines whether a fresh
 *  resolution would land on the same media row (see identityUnchanged). */
interface StoredIdentity {
  mediaId: string;
  mediaType: string;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  title: string;
  year: number | null;
  grandparentRatingKey: string | null;
  parentRatingKey: string | null;
  parentIndex: number | null;
  itemIndex: number | null;
  mediaShowMediaId: string | null;
  mediaMatchKey: string | null;
}

/** Batch-loads the stored identity of every (serverId, ratingKey) pair in
 *  `inputs`, one query per distinct server (matches the pattern already used
 *  by lookupShowIdsFromLibraryItems). Rows with no media_id yet are omitted -
 *  there is nothing to reuse for them. */
async function loadStoredIdentities(inputs: MatchKeyInput[]): Promise<Map<string, StoredIdentity>> {
  const byServer = new Map<string, Set<string>>();
  for (const input of inputs) {
    const keys = byServer.get(input.serverId) ?? new Set<string>();
    keys.add(input.ratingKey);
    byServer.set(input.serverId, keys);
  }

  const result = new Map<string, StoredIdentity>();
  for (const [serverId, ratingKeys] of byServer) {
    if (ratingKeys.size === 0) continue;
    const rows = await db
      .select({
        ratingKey: libraryItems.ratingKey,
        mediaId: libraryItems.mediaId,
        mediaType: libraryItems.mediaType,
        imdbId: libraryItems.imdbId,
        tmdbId: libraryItems.tmdbId,
        tvdbId: libraryItems.tvdbId,
        title: libraryItems.title,
        year: libraryItems.year,
        grandparentRatingKey: libraryItems.grandparentRatingKey,
        parentRatingKey: libraryItems.parentRatingKey,
        parentIndex: libraryItems.parentIndex,
        itemIndex: libraryItems.itemIndex,
        mediaShowMediaId: media.showMediaId,
        mediaMatchKey: media.matchKey,
      })
      .from(libraryItems)
      .leftJoin(media, eq(media.id, libraryItems.mediaId))
      .where(
        and(
          eq(libraryItems.serverId, serverId),
          inArray(libraryItems.ratingKey, Array.from(ratingKeys))
        )
      );
    for (const row of rows) {
      if (!row.mediaId) continue;
      result.set(`${serverId}:${row.ratingKey}`, {
        mediaId: row.mediaId,
        mediaType: row.mediaType,
        imdbId: row.imdbId,
        tmdbId: row.tmdbId,
        tvdbId: row.tvdbId,
        title: row.title,
        year: row.year,
        grandparentRatingKey: row.grandparentRatingKey,
        parentRatingKey: row.parentRatingKey,
        parentIndex: row.parentIndex,
        itemIndex: row.itemIndex,
        mediaShowMediaId: row.mediaShowMediaId ?? null,
        mediaMatchKey: row.mediaMatchKey ?? null,
      });
    }
  }
  return result;
}

/** True when every field that resolution can key off of (provider ids, title,
 *  year, and the show/season/episode hierarchy fields) is byte-identical to
 *  what's already stored. Deliberately excludes showMediaId: that's derived
 *  from grandparentRatingKey/parentRatingKey at resolve time, not a stored
 *  column, and an unchanged grandparentRatingKey already guarantees the same
 *  show lookup happens again. */
const MUSIC_MEDIA_TYPES = new Set(['track', 'album', 'artist']);

function identityUnchanged(input: MatchKeyInput, stored: StoredIdentity): boolean {
  const fieldsUnchanged =
    input.mediaType === stored.mediaType &&
    (input.imdbId ?? null) === stored.imdbId &&
    (input.tmdbId ?? null) === stored.tmdbId &&
    (input.tvdbId ?? null) === stored.tvdbId &&
    (input.title ?? '') === stored.title &&
    (input.year ?? null) === stored.year &&
    (input.grandparentRatingKey ?? null) === stored.grandparentRatingKey &&
    (input.parentRatingKey ?? null) === stored.parentRatingKey &&
    (input.seasonNumber ?? null) === stored.parentIndex &&
    (input.episodeNumber ?? null) === stored.itemIndex;
  if (!fieldsUnchanged) return false;
  // Music keys also depend on mbid/artist-album context, neither stored as its own column;
  // recomputing and diffing against the stored key catches a key-formula change raw fields can't.
  if (MUSIC_MEDIA_TYPES.has(input.mediaType))
    return buildMediaMatchKey(input) === stored.mediaMatchKey;
  return true;
}

/** Repairs a show link a prior sync left null without paying for the full
 *  locked resolve - only fires when the cache hit's media row is still
 *  missing show_media_id, so it can't clobber a value another sync set. */
async function repairShowMediaId(mediaId: string, showMediaId: string): Promise<string> {
  await db
    .update(media)
    .set({ showMediaId, updatedAt: new Date() })
    .where(and(eq(media.id, mediaId), isNull(media.showMediaId)));
  return mediaId;
}

async function findMergedAwayIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: media.id })
    .from(media)
    .where(and(inArray(media.id, ids), isNotNull(media.mergedIntoId)));
  return new Set(rows.map((r) => r.id));
}

// Multi-hit and lost-race inputs re-resolve under the advisory lock; keys sorted to avoid deadlock
async function resolveMediaMisses(inputs: MatchKeyInput[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (inputs.length === 0) return out;

  const residual: MatchKeyInput[] = [];
  const unresolved: MatchKeyInput[] = [];
  const hitsByRowId = new Map<string, { row: MediaRow; inputs: MatchKeyInput[] }>();
  const recordHit = (row: MediaRow, input: MatchKeyInput) => {
    const entry = hitsByRowId.get(row.id) ?? { row, inputs: [] };
    entry.inputs.push(input);
    hitsByRowId.set(row.id, entry);
  };

  const withIdsByType = new Map<string, MatchKeyInput[]>();
  const titleProbeByType = new Map<string, MatchKeyInput[]>();
  const secondChanceByType = new Map<string, MatchKeyInput[]>();
  const numberKeyAdopt: MatchKeyInput[] = [];
  const titleProbeEligible = (input: MatchKeyInput) =>
    (input.mediaType === 'movie' || input.mediaType === 'show') &&
    !!input.title &&
    !!normalizeTitle(input.title);
  for (const input of inputs) {
    if (input.imdbId || input.tmdbId || input.tvdbId) {
      const group = withIdsByType.get(input.mediaType) ?? [];
      group.push(input);
      withIdsByType.set(input.mediaType, group);
      continue;
    }
    if (!titleProbeEligible(input)) {
      unresolved.push(input);
      continue;
    }
    const group = titleProbeByType.get(input.mediaType) ?? [];
    group.push(input);
    titleProbeByType.set(input.mediaType, group);
  }

  for (const [mediaType, group] of withIdsByType) {
    const imdbIds = [...new Set(group.map((i) => i.imdbId).filter((v): v is string => !!v))];
    const tmdbIds = [...new Set(group.map((i) => i.tmdbId).filter((v): v is number => !!v))];
    const tvdbIds = [...new Set(group.map((i) => i.tvdbId).filter((v): v is number => !!v))];
    const conds = [];
    if (imdbIds.length > 0) conds.push(inArray(media.imdbId, imdbIds));
    if (tmdbIds.length > 0) conds.push(inArray(media.tmdbId, tmdbIds));
    if (tvdbIds.length > 0) conds.push(inArray(media.tvdbId, tvdbIds));
    const rows = await db
      .select()
      .from(media)
      .where(and(eq(media.mediaType, mediaType), isNull(media.mergedIntoId), or(...conds)));
    const byImdb = new Map<string, MediaRow[]>();
    const byTmdb = new Map<number, MediaRow[]>();
    const byTvdb = new Map<number, MediaRow[]>();
    for (const row of rows) {
      if (row.imdbId) byImdb.set(row.imdbId, [...(byImdb.get(row.imdbId) ?? []), row]);
      if (row.tmdbId) byTmdb.set(row.tmdbId, [...(byTmdb.get(row.tmdbId) ?? []), row]);
      if (row.tvdbId) byTvdb.set(row.tvdbId, [...(byTvdb.get(row.tvdbId) ?? []), row]);
    }
    for (const input of group) {
      const matched = new Map<string, MediaRow>();
      if (input.imdbId) for (const row of byImdb.get(input.imdbId) ?? []) matched.set(row.id, row);
      if (input.tmdbId) for (const row of byTmdb.get(input.tmdbId) ?? []) matched.set(row.id, row);
      if (input.tvdbId) for (const row of byTvdb.get(input.tvdbId) ?? []) matched.set(row.id, row);
      if (matched.size === 1) recordHit(Array.from(matched.values())[0]!, input);
      else if (matched.size > 1) residual.push(input);
      else if (titleProbeEligible(input)) {
        const chance = secondChanceByType.get(input.mediaType) ?? [];
        chance.push(input);
        secondChanceByType.set(input.mediaType, chance);
      } else if (episodeNumberKey(input)) numberKeyAdopt.push(input);
      else unresolved.push(input);
    }
  }

  // One read for every number key, then the lock only where a row exists, so a first sync of
  // a large show library does not open a transaction per new episode.
  if (numberKeyAdopt.length > 0) {
    const keys = [...new Set(numberKeyAdopt.map((input) => episodeNumberKey(input) ?? ''))];
    const present = new Set(
      (
        await db
          .select({ matchKey: media.matchKey })
          .from(media)
          .where(inArray(media.matchKey, keys))
      ).map((row) => row.matchKey)
    );
    for (const input of numberKeyAdopt) {
      const adopted = present.has(episodeNumberKey(input) ?? '')
        ? await db.transaction((tx) => adoptNumberKeyedEpisode(tx, input))
        : undefined;
      if (adopted) out.set(input.ratingKey, adopted.id);
      else unresolved.push(input);
    }
  }

  const probeTypes = new Set([...titleProbeByType.keys(), ...secondChanceByType.keys()]);
  for (const mediaType of probeTypes) {
    const idlessGroup = titleProbeByType.get(mediaType) ?? [];
    const secondChanceGroup = secondChanceByType.get(mediaType) ?? [];
    const titles = [
      ...new Set([...idlessGroup, ...secondChanceGroup].map((i) => normalizeTitle(i.title!))),
    ];
    const rows = await db
      .select()
      .from(media)
      .where(
        and(
          eq(media.mediaType, mediaType),
          isNull(media.mergedIntoId),
          inArray(media.normalizedTitle, titles)
        )
      )
      .orderBy(sql.raw(OLDEST_FIRST_SQL));
    for (const input of idlessGroup) {
      const normalized = normalizeTitle(input.title!);
      const year = input.year ?? 0;
      // A row without a year (an import that knew only the title) fits any year, as it does
      // for an id-bearing input, but a row whose year fits comes first; rows arrive oldest first.
      const fitting = rows.filter(
        (r) =>
          r.normalizedTitle === normalized &&
          (r.year == null || (r.year >= year - 1 && r.year <= year + 1))
      );
      const row = fitting.find((r) => r.year != null) ?? fitting[0];
      if (row) recordHit(row, input);
      else unresolved.push(input);
    }
    // Siblings in one batch can pass the probe against the same stale snapshot; conflicting claims re-resolve under the advisory lock, which sees the first claim's backfill
    const claimedIdsByRowId = new Map<
      string,
      { imdbId: string | null; tmdbId: number | null; tvdbId: number | null }
    >();
    for (const input of secondChanceGroup) {
      const row = pickIdBearingTitleCandidate(input, rows);
      if (!row) {
        unresolved.push(input);
        continue;
      }
      const claimed = claimedIdsByRowId.get(row.id) ?? {
        imdbId: row.imdbId,
        tmdbId: row.tmdbId,
        tvdbId: row.tvdbId,
      };
      if (providerIdsConflict(input, claimed)) {
        residual.push(input);
        continue;
      }
      claimed.imdbId = claimed.imdbId ?? input.imdbId ?? null;
      claimed.tmdbId = claimed.tmdbId ?? input.tmdbId ?? null;
      claimed.tvdbId = claimed.tvdbId ?? input.tvdbId ?? null;
      claimedIdsByRowId.set(row.id, claimed);
      recordHit(row, input);
    }
  }

  for (const { row, inputs: rowInputs } of hitsByRowId.values()) {
    const first = rowInputs[0]!;
    await backfillProviderIds(db, row, {
      ...first,
      imdbId: rowInputs.find((i) => i.imdbId)?.imdbId ?? null,
      tmdbId: rowInputs.find((i) => i.tmdbId)?.tmdbId ?? null,
      tvdbId: rowInputs.find((i) => i.tvdbId)?.tvdbId ?? null,
      showMediaId: rowInputs.find((i) => i.showMediaId)?.showMediaId ?? null,
    });
    for (const input of rowInputs) out.set(input.ratingKey, row.id);
  }

  const insertGroups = new Map<string, MatchKeyInput[]>();
  for (const input of unresolved) {
    const matchKey = buildMediaMatchKey(input);
    const group = insertGroups.get(matchKey) ?? [];
    group.push(input);
    insertGroups.set(matchKey, group);
  }
  if (insertGroups.size > 0) {
    const sortedKeys = Array.from(insertGroups.keys()).sort();
    const inserted = await db
      .insert(media)
      .values(
        sortedKeys.map((matchKey) => {
          const group = insertGroups.get(matchKey)!;
          const first = group[0]!;
          return {
            mediaType: first.mediaType,
            matchKey,
            imdbId: group.find((i) => i.imdbId)?.imdbId ?? null,
            tmdbId: group.find((i) => i.tmdbId)?.tmdbId ?? null,
            tvdbId: group.find((i) => i.tvdbId)?.tvdbId ?? null,
            title: first.title ?? '',
            normalizedTitle: first.title ? normalizeTitle(first.title) || null : null,
            sortTitle: buildSortTitle(first.title ?? ''),
            year: first.year ?? null,
            showMediaId: group.find((i) => i.showMediaId)?.showMediaId ?? null,
          };
        })
      )
      .onConflictDoNothing({ target: media.matchKey })
      .returning({ id: media.id, matchKey: media.matchKey });
    const idByMatchKey = new Map(inserted.map((r) => [r.matchKey, r.id]));
    for (const [matchKey, group] of insertGroups) {
      const id = idByMatchKey.get(matchKey);
      if (!id) {
        residual.push(...group);
        continue;
      }
      for (const input of group) out.set(input.ratingKey, id);
    }
  }

  for (const input of residual) {
    out.set(input.ratingKey, await resolveMediaForItem(input));
  }
  return out;
}

export async function resolveMediaBatch(inputs: MatchKeyInput[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const byType = (t: string) => inputs.filter((i) => i.mediaType === t);
  const rest = inputs.filter((i) => !['show', 'season'].includes(i.mediaType));

  // A cache hit's stored read can be arbitrarily old; findMergedAwayIds below (not this comparison) is what keeps a since-merged-away id from reaching the caller's write.
  const stored = await loadStoredIdentities(inputs);
  const resolvedInputByRatingKey = new Map<string, MatchKeyInput>();
  const resolvePhase = async (phaseInputs: MatchKeyInput[]): Promise<void> => {
    const misses: MatchKeyInput[] = [];
    for (const input of phaseInputs) {
      resolvedInputByRatingKey.set(input.ratingKey, input);
      const cached = stored.get(`${input.serverId}:${input.ratingKey}`);
      if (cached && identityUnchanged(input, cached)) {
        if (input.showMediaId && !cached.mediaShowMediaId) {
          result.set(input.ratingKey, await repairShowMediaId(cached.mediaId, input.showMediaId));
        } else {
          result.set(input.ratingKey, cached.mediaId);
        }
        continue;
      }
      misses.push(input);
    }
    for (const [ratingKey, id] of await resolveMediaMisses(misses)) {
      result.set(ratingKey, id);
    }
  };

  await resolvePhase(byType('show'));
  const showIdByRatingKey = new Map<string, string>();
  for (const show of byType('show')) {
    showIdByRatingKey.set(show.ratingKey, result.get(show.ratingKey)!);
  }

  // A season's own parentRatingKey is its show (Plex); episodes/tracks use grandparentRatingKey.
  const seasons = byType('season');
  const seasonShowKey = (s: MatchKeyInput): string | undefined =>
    s.grandparentRatingKey ?? s.parentRatingKey ?? undefined;

  const missingShowLookups = new Map<string, Set<string>>();
  const noteMissing = (serverId: string, key: string | undefined) => {
    if (!key || showIdByRatingKey.has(key)) return;
    const keys = missingShowLookups.get(serverId) ?? new Set<string>();
    keys.add(key);
    missingShowLookups.set(serverId, keys);
  };
  for (const season of seasons) {
    if (season.showMediaId == null) noteMissing(season.serverId, seasonShowKey(season));
  }
  for (const item of rest) {
    if (item.showMediaId == null)
      noteMissing(item.serverId, item.grandparentRatingKey ?? undefined);
  }

  const dbShowIdByServerRatingKey = await lookupShowIdsFromLibraryItems(missingShowLookups);
  if (missingShowLookups.size > 0) {
    const candidateCount = Array.from(missingShowLookups.values()).reduce(
      (n, keys) => n + keys.size,
      0
    );
    const unresolved = candidateCount - dbShowIdByServerRatingKey.size;
    if (unresolved > 0) {
      console.debug(
        `[mediaResolutionService] ${unresolved} item(s) reference a show not yet synced; ` +
          'show_media_id left null (self-heals on a later sync)'
      );
    }
  }

  await resolvePhase(
    seasons.map((season) => {
      const parentKey = seasonShowKey(season);
      const showMediaId =
        season.showMediaId ??
        (parentKey ? showIdByRatingKey.get(parentKey) : undefined) ??
        (parentKey
          ? dbShowIdByServerRatingKey.get(`${season.serverId}:${parentKey}`)
          : undefined) ??
        null;
      return { ...season, showMediaId };
    })
  );

  await resolvePhase(
    rest.map((item) => {
      const showMediaId =
        item.showMediaId ??
        (item.grandparentRatingKey
          ? showIdByRatingKey.get(item.grandparentRatingKey)
          : undefined) ??
        (item.grandparentRatingKey
          ? dbShowIdByServerRatingKey.get(`${item.serverId}:${item.grandparentRatingKey}`)
          : undefined) ??
        null;
      return { ...item, showMediaId };
    })
  );

  const staleIds = await findMergedAwayIds(Array.from(new Set(result.values())));
  if (staleIds.size > 0) {
    for (const [ratingKey, id] of result) {
      if (!staleIds.has(id)) continue;
      const input = resolvedInputByRatingKey.get(ratingKey);
      if (!input) continue;
      result.set(ratingKey, await resolveMediaForItem(input));
    }
  }

  return result;
}

export async function reconcileMediaDuplicates(): Promise<number> {
  let merges = 0;
  for (const col of ['imdb_id', 'tmdb_id', 'tvdb_id'] as const) {
    // Duplicated values are found first so only their rows pay for the ordered aggregate
    const dupes = (await db.execute(
      sql.raw(`
      SELECT array_agg(id ORDER BY ${OLDEST_FIRST_SQL}) AS ids
      FROM media
      WHERE merged_into_id IS NULL
        AND (media_type, ${col}) IN (
          SELECT media_type, ${col}
          FROM media
          WHERE ${col} IS NOT NULL AND merged_into_id IS NULL
          GROUP BY media_type, ${col}
          HAVING COUNT(*) > 1
        )
      GROUP BY media_type, ${col}
    `)
    )) as unknown as { rows: Array<{ ids: string[] }> };
    for (const row of dupes.rows) {
      const [winner, ...losers] = row.ids;
      for (const loser of losers) {
        await mergeMediaRows(winner!, loser);
        merges += 1;
      }
    }
  }
  // Safety net for title-keyed race artifacts the advisory lock cannot cover
  const titleDupes = (await db.execute(
    sql.raw(`
      SELECT array_agg(id ORDER BY ${OLDEST_FIRST_SQL}) AS ids,
             array_agg(COALESCE(year, 0) ORDER BY ${OLDEST_FIRST_SQL}) AS years
      FROM media
      WHERE merged_into_id IS NULL
        AND media_type IN ('movie', 'show')
        AND imdb_id IS NULL AND tmdb_id IS NULL AND tvdb_id IS NULL
        AND normalized_title IS NOT NULL AND normalized_title <> ''
      GROUP BY media_type, normalized_title
      HAVING COUNT(*) > 1
    `)
  )) as unknown as { rows: Array<{ ids: string[]; years: number[] }> };
  for (const row of titleDupes.rows) {
    const [winner, ...losers] = row.ids;
    const winnerYear = row.years[0]!;
    for (const [i, loser] of losers.entries()) {
      if (Math.abs(row.years[i + 1]! - winnerYear) > 1) continue;
      await mergeMediaRows(winner!, loser);
      merges += 1;
    }
  }
  merges += await reconcileSplitProviderIdRows();
  merges += await reconcileNumberKeyedEpisodes();
  return merges;
}

/**
 * An import that resolved an episode by show and number while the library sync was creating
 * the same episode by provider id leaves two rows: neither side could see the other's row
 * before the library item was written. Once the item is there, the number-keyed, id-less row
 * that no library item holds merges into the item's row, and only when exactly one canonical
 * row holds that number (two servers keeping their own rows for one number stay apart).
 */
async function reconcileNumberKeyedEpisodes(): Promise<number> {
  const pairs = (await db.execute(
    sql.raw(`
      SELECT n.id AS loser, min(em.id::text)::uuid AS winner
      FROM media n
      JOIN media sm ON COALESCE(sm.merged_into_id, sm.id) = n.show_media_id
      JOIN library_items sh ON sh.media_id = sm.id AND sh.media_type = 'show'
      JOIN library_items e ON e.server_id = sh.server_id AND e.grandparent_rating_key = sh.rating_key
        AND e.media_type = 'episode' AND e.media_id IS NOT NULL
        AND n.match_key = 'episode:' || n.show_media_id || ':s' || e.parent_index || 'e' || e.item_index
      JOIN media em ON em.id = COALESCE((SELECT x.merged_into_id FROM media x WHERE x.id = e.media_id), e.media_id)
        AND em.merged_into_id IS NULL AND em.id <> n.id
      WHERE n.media_type = 'episode' AND n.merged_into_id IS NULL
        AND n.imdb_id IS NULL AND n.tmdb_id IS NULL AND n.tvdb_id IS NULL
        AND n.match_key LIKE 'episode:%'
        AND NOT EXISTS (SELECT 1 FROM library_items x WHERE x.media_id = n.id)
      GROUP BY n.id
      HAVING count(DISTINCT em.id) = 1
      ORDER BY n.id
    `)
  )) as unknown as { rows: Array<{ loser: string; winner: string }> };
  const done = new Set<string>();
  for (const { loser, winner } of pairs.rows) {
    if (done.has(loser)) continue;
    await mergeMediaRows(winner, loser);
    done.add(loser);
  }
  return done.size;
}

async function reconcileSplitProviderIdRows(): Promise<number> {
  let merges = 0;
  const groups = (await db.execute(
    sql.raw(`
      SELECT array_agg(id ORDER BY ${OLDEST_FIRST_SQL}) AS ids,
             array_agg(year ORDER BY ${OLDEST_FIRST_SQL}) AS years,
             array_agg(imdb_id ORDER BY ${OLDEST_FIRST_SQL}) AS imdb_ids,
             array_agg(tmdb_id ORDER BY ${OLDEST_FIRST_SQL}) AS tmdb_ids,
             array_agg(tvdb_id ORDER BY ${OLDEST_FIRST_SQL}) AS tvdb_ids
      FROM media
      WHERE merged_into_id IS NULL
        AND media_type IN ('movie', 'show')
        AND normalized_title IS NOT NULL AND normalized_title <> ''
      GROUP BY media_type, normalized_title
      HAVING COUNT(*) > 1
         AND COUNT(*) FILTER (
           WHERE imdb_id IS NOT NULL OR tmdb_id IS NOT NULL OR tvdb_id IS NOT NULL
         ) > 0
    `)
  )) as unknown as {
    rows: Array<{
      ids: string[];
      years: Array<number | null>;
      imdb_ids: Array<string | null>;
      tmdb_ids: Array<number | null>;
      tvdb_ids: Array<number | null>;
    }>;
  };
  for (const group of groups.rows) {
    const members = group.ids.map((id, i) => ({
      id,
      year: group.years[i] ?? null,
      imdbId: group.imdb_ids[i] ?? null,
      tmdbId: group.tmdb_ids[i] ?? null,
      tvdbId: group.tvdb_ids[i] ?? null,
    }));
    const knownYears = new Set(members.map((m) => m.year).filter((y): y is number => y != null));
    const soleYear = knownYears.size === 1 ? [...knownYears][0]! : null;
    const buckets = new Map<number | 'none', typeof members>();
    for (const m of members) {
      let key: number | 'none';
      if (m.year != null) key = m.year;
      else if (knownYears.size === 0) key = 'none';
      else if (soleYear != null) key = soleYear;
      else continue;
      const bucket = buckets.get(key) ?? [];
      bucket.push(m);
      buckets.set(key, bucket);
    }
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      const conflict =
        new Set(bucket.map((m) => m.imdbId).filter((v) => v != null)).size > 1 ||
        new Set(bucket.map((m) => m.tmdbId).filter((v) => v != null)).size > 1 ||
        new Set(bucket.map((m) => m.tvdbId).filter((v) => v != null)).size > 1;
      if (conflict) continue;
      const [winner, ...losers] = bucket;
      for (const loser of losers) {
        await mergeMediaRows(winner!.id, loser.id);
        merges += 1;
        if (winner!.year == null || loser.year == null) {
          console.debug(
            `[mediaResolutionService] reconcile merged media ${loser.id} ` +
              `(imdb ${loser.imdbId ?? '-'}, tmdb ${loser.tmdbId ?? '-'}, tvdb ${loser.tvdbId ?? '-'}) ` +
              `into ${winner!.id} ` +
              `(imdb ${winner!.imdbId ?? '-'}, tmdb ${winner!.tmdbId ?? '-'}, tvdb ${winner!.tvdbId ?? '-'}) ` +
              'on a missing year, not an equal one'
          );
        }
      }
    }
  }
  return merges;
}
