import { sql, type SQL } from 'drizzle-orm';
import countries from 'i18n-iso-countries';
import countriesEn from 'i18n-iso-countries/langs/en.json' with { type: 'json' };
import { resolutionDisplayName } from '@tracearr/shared';
import { db } from '../db/client.js';
import { uncapDecompressionForTx } from '../db/timescale.js';
import { normalizeClient, normalizePlatformName } from '../utils/platformNormalizer.js';
import {
  drainWindowsWithBisection,
  sessionWalkWindows,
  ts,
  type BackfillWindow,
} from './sessionWalk.js';

countries.registerLocale(countriesEn);

const NORMALIZE_BATCH_SIZE = 500;
const CODEC_BATCH_SIZE = 1000;

type Window = Required<BackfillWindow> | null;

interface Cursor {
  startedAt: string;
  id: string;
}

interface Candidate {
  id: string;
  /** Postgres text, microseconds intact */
  started_at: string;
}

interface WrittenColumn {
  name: string;
  type: string;
}

type NormalizeOnBatch = (
  total: number,
  counts?: { updated: number; skipped: number; errors: number }
) => Promise<void>;

export interface NormalizeWalkResult {
  total: number;
  failedRanges: string[];
  details: string;
  processed: number;
  skipped: number;
  errors: number;
}

function windowBounds(window: Window): SQL {
  return window
    ? sql`s.started_at >= ${ts(window.start)} AND s.started_at < ${ts(window.end)}`
    : sql`TRUE`;
}

/**
 * Reads one window newest first in cursor pages, lets plan() decide each row's new values (null
 * leaves the row alone), and writes a page's changes in one statement. The cursor is exclusive:
 * the filter also matches rows that need no change, so they would come back otherwise.
 */
export async function normalizeWalk(opts: {
  label: string;
  /** Extra columns plan() reads, as `s.col` references */
  select: SQL;
  /** Which rows are candidates; repeated on the write so a row that changed meanwhile is skipped */
  where: SQL;
  columns: WrittenColumn[];
  /** Method syntax so each job can type its own row */
  plan(row: Candidate): Record<string, unknown> | null;
  onBatch: NormalizeOnBatch;
  batchSize?: number;
  /** Called with the oldest started_at of every page that wrote rows */
  onCommit?: (oldest: Date) => void;
}): Promise<NormalizeWalkResult> {
  const batchSize = opts.batchSize ?? NORMALIZE_BATCH_SIZE;
  const definitions = sql.raw(opts.columns.map((c) => `${c.name} ${c.type}`).join(', '));
  const assignments = sql.raw(opts.columns.map((c) => `${c.name} = u.${c.name}`).join(', '));

  // A window that fails after some batches committed is drained again in halves, which can look
  // at those rows again or, when the filter excludes what was written, never see them. Each row is
  // counted once per top-level window, when its batch commits.
  const windows = await sessionWalkWindows(null);
  const topLevel = new Set(windows);
  const counted = new Set<string>();
  const total = { examined: 0, updated: 0, errors: 0 };
  const counts = () => ({
    examined: total.examined,
    errors: total.errors,
    updated: total.updated,
    skipped: total.examined - total.updated - total.errors,
  });

  const runBatch = async (window: Window, cursor: Cursor | undefined) => {
    if (!cursor && (window === null || topLevel.has(window))) counted.clear();
    const batch = await db.transaction(async (tx) => {
      await uncapDecompressionForTx(tx);
      const selected = await tx.execute(sql`
        SELECT s.id, s.started_at::text AS started_at, ${opts.select}
        FROM sessions s
        WHERE ${opts.where}
          AND ${windowBounds(window)}
          ${cursor ? sql`AND (s.started_at, s.id) < (${cursor.startedAt}::timestamptz, ${cursor.id}::uuid)` : sql``}
        ORDER BY s.started_at DESC, s.id DESC
        LIMIT ${batchSize}
      `);
      const rows = selected.rows as unknown as Candidate[];

      const changes: Record<string, unknown>[] = [];
      const failed = new Set<string>();
      let oldestChanged: string | null = null;
      for (const row of rows) {
        try {
          const values = opts.plan(row);
          if (!values) continue;
          changes.push({ id: row.id, started_at: row.started_at, ...values });
          oldestChanged = row.started_at;
        } catch (error) {
          console.error(`[${opts.label}] Error processing session ${row.id}:`, error);
          failed.add(row.id);
        }
      }

      let updated = 0;
      if (changes.length > 0) {
        const written = await tx.execute(sql`
          UPDATE sessions s SET ${assignments}
          FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb)
            AS u(id uuid, started_at timestamptz, ${definitions})
          WHERE s.id = u.id AND s.started_at = u.started_at
            AND ${windowBounds(window)} AND ${opts.where}
        `);
        updated = Number(written.rowCount ?? 0);
      }
      return { rows, failed, updated, oldestChanged };
    });

    total.updated += batch.updated;
    for (const row of batch.rows) {
      // A plain table drains once without retries, so there is nothing to dedupe.
      if (windows) {
        if (counted.has(row.id)) continue;
        counted.add(row.id);
      }
      total.examined++;
      if (batch.failed.has(row.id)) total.errors++;
    }
    if (batch.oldestChanged && batch.updated > 0) opts.onCommit?.(new Date(batch.oldestChanged));
    const last = batch.rows.at(-1);
    if (!last) return { count: 0, oldest: null };
    return {
      count: batch.rows.length,
      oldest: new Date(last.started_at),
      cursor: { startedAt: last.started_at, id: last.id },
    };
  };

  const result = await drainWindowsWithBisection(windows, runBatch, {
    batchSize,
    label: opts.label,
    onBatch: async () => {
      const { examined, ...live } = counts();
      await opts.onBatch(examined, live);
    },
  });
  const done = counts();
  return {
    total: done.updated,
    failedRanges: result.failedRanges,
    details: '',
    processed: done.examined,
    skipped: done.skipped,
    errors: done.errors,
  };
}

type Hooks = { onBatch: NormalizeOnBatch; onCommit?: (oldest: Date) => void };

export function walkNormalizePlayers(hooks: Hooks) {
  return normalizeWalk({
    ...hooks,
    label: 'NormalizePlayers',
    select: sql`s.product, s.player_name, s.device, s.platform`,
    where: sql`(s.product IS NOT NULL OR s.player_name IS NOT NULL OR s.platform IS NOT NULL)`,
    columns: [
      { name: 'device', type: 'text' },
      { name: 'platform', type: 'text' },
    ],
    plan: (
      row: Candidate & {
        product: string | null;
        player_name: string | null;
        device: string | null;
        platform: string | null;
      }
    ) => {
      const clientString = row.product || row.player_name || '';
      if (!clientString && !row.platform) return null;
      // The stored device is the value being fixed, so it is not passed as a hint.
      const normalized = normalizeClient(clientString);
      const platform = row.platform ? normalizePlatformName(row.platform) : normalized.platform;
      if (normalized.device === row.device && platform === row.platform) return null;
      return { device: normalized.device, platform };
    },
  });
}

export function walkNormalizeCountries(hooks: Hooks) {
  return normalizeWalk({
    ...hooks,
    label: 'NormalizeCountries',
    select: sql`s.geo_city, s.geo_country`,
    where: sql`((s.geo_country IS NOT NULL AND length(s.geo_country) > 2) OR lower(s.geo_city) = 'local')`,
    columns: [
      { name: 'geo_city', type: 'text' },
      { name: 'geo_country', type: 'text' },
    ],
    plan: (row: Candidate & { geo_city: string | null; geo_country: string | null }) => {
      const city = row.geo_city;
      const country = row.geo_country;
      if (city?.toLowerCase() === 'local') return { geo_city: null, geo_country: 'Local Network' };
      if (!country || country.length <= 2) return null;
      if (country.toLowerCase() === 'local' || country.toLowerCase() === 'local network') {
        return country === 'Local Network'
          ? null
          : { geo_city: city, geo_country: 'Local Network' };
      }
      const iso = countries.getAlpha2Code(country, 'en');
      return iso ? { geo_city: city, geo_country: iso } : null;
    },
  });
}

const MEDIAN_DURATION_MS: Record<string, number> = {
  episode: 42 * 60 * 1000,
  movie: 109 * 60 * 1000,
  track: 4 * 60 * 1000,
};
const DEFAULT_MEDIAN_DURATION_MS = 60 * 60 * 1000;

export const PROGRESS_COLUMNS = ['progress_ms', 'total_duration_ms'];

/** Hooks.onCommit matters here: progress_ms and total_duration_ms feed daily_content_engagement. */
export function walkFixImportedProgress(hooks: Hooks) {
  return normalizeWalk({
    ...hooks,
    label: 'FixImportedProgress',
    select: sql`s.duration_ms::float8 AS duration_ms, s.watched, s.media_type`,
    where: sql`(s.external_session_id IS NOT NULL AND s.duration_ms IS NOT NULL
      AND s.progress_ms IS NULL AND s.total_duration_ms IS NULL
      AND s.server_id IN (SELECT id FROM servers WHERE type = 'plex'))`,
    columns: PROGRESS_COLUMNS.map((name) => ({ name, type: 'bigint' })),
    plan: (
      row: Candidate & { duration_ms: number | null; watched: boolean; media_type: string | null }
    ) => {
      const durationMs = row.duration_ms;
      if (durationMs === null || durationMs <= 0) return null;
      // A watched row reached the ~85% watch threshold; otherwise assume the media type's median length.
      const totalDurationMs = row.watched
        ? Math.round(durationMs / 0.85)
        : Math.max(
            MEDIAN_DURATION_MS[row.media_type ?? ''] ?? DEFAULT_MEDIAN_DURATION_MS,
            durationMs
          );
      return { progress_ms: durationMs, total_duration_ms: totalDurationMs };
    },
  });
}

export function walkNormalizeResolutions(hooks: Hooks) {
  return normalizeWalk({
    ...hooks,
    label: 'NormalizeResolutions',
    select: sql`s.quality, s.source_video_width, s.source_video_height`,
    where: sql`(s.source_video_width IS NOT NULL AND s.source_video_height IS NOT NULL)`,
    columns: [{ name: 'quality', type: 'text' }],
    plan: (
      row: Candidate & {
        quality: string | null;
        source_video_width: number;
        source_video_height: number;
      }
    ) => {
      const recomputed = resolutionDisplayName({
        width: row.source_video_width,
        height: row.source_video_height,
      });
      return recomputed && recomputed !== row.quality ? { quality: recomputed } : null;
    },
  });
}

const CODEC_COLUMNS = [
  'source_video_codec',
  'source_audio_codec',
  'stream_video_codec',
  'stream_audio_codec',
];

export async function walkNormalizeCodecs(
  hooks: Pick<Hooks, 'onBatch'>
): Promise<NormalizeWalkResult> {
  const lowercase = sql.raw(
    CODEC_COLUMNS.map((c) => `s.${c} IS DISTINCT FROM UPPER(s.${c})`).join(' OR ')
  );
  const assignments = sql.raw(CODEC_COLUMNS.map((c) => `${c} = UPPER(${c})`).join(', '));
  const runBatch = (window: Window) =>
    db.transaction(async (tx) => {
      await uncapDecompressionForTx(tx);
      const written = await tx.execute(sql`
        UPDATE sessions SET ${assignments}
        WHERE (id, started_at) IN (
          SELECT s.id, s.started_at FROM sessions s
          WHERE ${windowBounds(window)} AND (${lowercase})
          LIMIT ${CODEC_BATCH_SIZE}
        )
        ${window ? sql`AND started_at >= ${ts(window.start)} AND started_at < ${ts(window.end)}` : sql``}
      `);
      return { count: Number(written.rowCount ?? 0), oldest: null };
    });
  const result = await drainWindowsWithBisection(await sessionWalkWindows(null), runBatch, {
    batchSize: CODEC_BATCH_SIZE,
    label: 'NormalizeCodecs',
    onBatch: hooks.onBatch,
  });
  return {
    total: result.total,
    failedRanges: result.failedRanges,
    details: '',
    processed: result.total,
    skipped: 0,
    errors: 0,
  };
}
