/**
 * Codec filtering for the browse catalog.
 *
 * The codec charts group raw stored codecs ('H264', 'AVC1', 'X264') under one
 * display name through codecNormalizer, so the catalog filter takes that same
 * display name and expands it back to every raw value the normalizer folds
 * into it. Doing the fold here, rather than re-implementing it in SQL, keeps
 * a chart bar and the filtered grid it links to counting the same files.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  normalizeAudioChannels,
  normalizeAudioCodec,
  normalizeVideoCodec,
} from '../../utils/codecNormalizer.js';
import { libraryFragment, type Scope } from '../../lib/scope.js';

/** Channel counts ride the same path: the chart folds raw integers into 'Stereo', '5.1'. */
export type CodecKind = 'video' | 'audio' | 'channels';

/** Raw stored values: codec strings, or integer channel counts. */
export type RawCodec = string | number;

const COLUMNS: Record<CodecKind, SQL> = {
  video: sql.raw('video_codec'),
  audio: sql.raw('audio_codec'),
  channels: sql.raw('audio_channels'),
};

const NORMALIZERS: Record<CodecKind, (raw: RawCodec) => string> = {
  video: (raw) => normalizeVideoCodec(String(raw)),
  audio: (raw) => normalizeAudioCodec(String(raw)),
  channels: (raw) => normalizeAudioChannels(Number(raw)),
};

async function distinctRawCodecs(kind: CodecKind): Promise<RawCodec[]> {
  const column = COLUMNS[kind];
  const result = await db.execute(sql`
    SELECT DISTINCT ${column} AS codec FROM library_item_versions
    WHERE removed_at IS NULL AND ${column} IS NOT NULL
  `);
  return (result.rows as { codec: RawCodec }[]).map((row) => row.codec);
}

/** Raw stored values the chart folds into `name`; null when no filter is set,
 * an empty array when the name matches nothing (the filter then matches nothing). */
export async function resolveRawCodecs(
  kind: CodecKind,
  name: string | undefined
): Promise<RawCodec[] | null> {
  if (!name) return null;
  const normalize = NORMALIZERS[kind];
  return (await distinctRawCodecs(kind)).filter((raw) => normalize(raw) === name);
}

/** `AND <alias>.<codec column> IN (...)`, bound as parameters. */
export function codecPredicate(kind: CodecKind, alias: string, rawCodecs: RawCodec[]): SQL {
  if (rawCodecs.length === 0) return sql`AND FALSE`;
  return sql`AND ${sql.raw(alias)}.${COLUMNS[kind]} IN (${sql.join(
    rawCodecs.map((codec) => sql`${codec}`),
    sql`, `
  )})`;
}

/** Display names present among one browse type's files in scope, most common first. */
export async function fetchCodecOptions(
  type: 'movie' | 'show',
  serverIds: string[] | undefined,
  scope: Scope
): Promise<Record<CodecKind, string[]>> {
  const itemType = type === 'movie' ? 'movie' : 'episode';
  const serverFragment = libraryFragment(serverIds, scope, 'li');
  const options = async (kind: CodecKind): Promise<string[]> => {
    const column = COLUMNS[kind];
    const result = await db.execute(sql`
      SELECT v.${column} AS codec, COUNT(DISTINCT li.id)::int AS count
      FROM library_items li
      JOIN library_item_versions v ON v.library_item_id = li.id AND v.removed_at IS NULL
      WHERE li.media_type = ${itemType} AND li.removed_at IS NULL AND v.${column} IS NOT NULL
        ${serverFragment}
      GROUP BY v.${column}
    `);
    const counts = new Map<string, number>();
    for (const row of result.rows as { codec: RawCodec; count: number }[]) {
      const name = NORMALIZERS[kind](row.codec);
      counts.set(name, (counts.get(name) ?? 0) + Number(row.count));
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  };
  const [video, audio, channels] = await Promise.all([
    options('video'),
    options('audio'),
    options('channels'),
  ]);
  return { video, audio, channels };
}
