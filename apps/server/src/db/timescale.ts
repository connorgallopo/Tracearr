/**
 * TimescaleDB initialization and setup
 *
 * This module ensures TimescaleDB features are properly configured for the sessions table.
 * It runs on every server startup and is idempotent - safe to run multiple times.
 */

import { createRawPgClient, db, recreatePool } from './client.js';
import { sql, type SQL } from 'drizzle-orm';
import type pg from 'pg';
import { PRIMARY_MEDIA_TYPES_SQL_LITERAL } from '../constants/mediaTypes.js';

/**
 * Schema version for continuous aggregate definitions.
 * INCREMENT THIS when any continuous aggregate WHERE clause or structure changes.
 * This triggers automatic rebuild of all aggregates on next server startup.
 *
 * Version history:
 * - 1: Initial version (no media_type filtering)
 * - 2: Added media_type IN ('movie', 'episode') filter to all aggregates
 * - 3: Added daily_bandwidth_by_user aggregate for bandwidth analytics
 * - 4: Added library_stats_daily and content_quality_daily aggregates for library statistics
 * - 5: Added music_count to library_stats_daily for /growth route optimization
 * - 6: Removed unused aggregates (daily_plays_by_user, daily_plays_by_server,
 *      daily_stats_summary, hourly_concurrent_streams) - no routes query them
 * - 7: Added materialized_only=false to all aggregates, removed toolkit/fallback split
 *      (no toolkit hyperfunctions were actually used)
 * - 8: Fixed plays calculation in content_engagement_summary to align with 85% "watched"
 * - 9: Added max_progress_ms to daily_content_engagement for progress-based completion detection.
 *      Duration-based completion undercounted episodes/plays for users who skip intros/credits.
 * - 10: Fixed top_shows_by_engagement.unique_viewers to count distinct people (server_users.user_id)
 *       instead of distinct server accounts, so a merged person watching a show from two accounts
 *       counts once - matching the date-filtered /shows path, which already counted by user_id.
 * - 11: Added media identity: media_id/show_media_id on daily_content_engagement and
 *       content_engagement_summary, plus the user_media_plays_daily aggregate.
 * - 12: Added any_watched to user_media_plays_daily and a show_media_id index.
 * - 13: No aggregate definition change. Bumped to trigger a full historical
 *       backfill after the episode->show linkage fix (media.show_media_id was
 *       null for every episode, so user_media_plays_daily rows materialized
 *       before the fix carry a null show_media_id baked in). The migration
 *       repairs media/sessions, but only a full aggregate recompute picks up
 *       the correction for rows outside the refresh policy's 7-day window.
 * - 14: Added count_high_quality and version_count (multi-version rollups) to
 *       library_stats_daily and content_quality_daily. Resolution buckets in
 *       source snapshots are overlapping from this version on.
 * - 15: Migration 0096 repoints sessions onto the surviving account when it
 *       repairs a legacy plex owner. Every per-user aggregate groups by
 *       server_user_id, so buckets materialized before the repair still credit
 *       the deleted account.
 */
export const AGGREGATE_SCHEMA_VERSION = 15;

/** Config for a continuous aggregate view */
interface AggregateDefinition {
  name: string;
  sql: string;
  refreshPolicy: {
    startOffset: string;
    endOffset: string;
    scheduleInterval: string;
  };
}

/**
 * All continuous aggregate definitions.
 *
 * Note: Removed unused aggregates in v6:
 * - daily_plays_by_user (no route queries it - routes use raw sessions)
 * - daily_plays_by_server (no route queries it - routes use raw sessions)
 * - daily_stats_summary (no route queries it - dashboard uses prepared statements)
 * - hourly_concurrent_streams (no route queries it - /stats/concurrent queries raw)
 */
function getAggregateDefinitions(): AggregateDefinition[] {
  const mediaFilter = PRIMARY_MEDIA_TYPES_SQL_LITERAL;

  return [
    {
      // Used by: /stats/engagement, /library/completion, /library/patterns
      name: 'daily_content_engagement',
      sql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS daily_content_engagement
        WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
        SELECT
          time_bucket('1 day', started_at) AS day,
          server_user_id,
          rating_key,
          MAX(media_title) AS media_title,
          MAX(grandparent_title) AS show_title,
          MAX(media_type) AS media_type,
          MAX(total_duration_ms) AS content_duration_ms,
          MAX(thumb_path) AS thumb_path,
          MAX(server_id::text)::uuid AS server_id,
          MAX(media_id::text)::uuid AS media_id,
          MAX(show_media_id::text)::uuid AS show_media_id,
          MAX(season_number) AS season_number,
          MAX(episode_number) AS episode_number,
          MAX(year) AS year,
          SUM(CASE WHEN duration_ms >= 120000 THEN duration_ms ELSE 0 END) AS watched_ms,
          MAX(CASE WHEN duration_ms >= 120000 THEN progress_ms ELSE NULL END) AS max_progress_ms,
          COUNT(*) FILTER (WHERE duration_ms >= 120000) AS valid_session_count,
          COUNT(*) AS total_session_count,
          BOOL_OR(watched) AS any_marked_watched
        FROM sessions
        WHERE rating_key IS NOT NULL
          AND total_duration_ms > 0
          AND ${mediaFilter}
        GROUP BY day, server_user_id, rating_key
        WITH NO DATA
      `,
      refreshPolicy: {
        startOffset: '7 days',
        endOffset: '1 hour',
        scheduleInterval: '15 minutes',
      },
    },
    {
      // Identity-aware plays: one row per user-media-day actually watched
      name: 'user_media_plays_daily',
      sql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS user_media_plays_daily
        WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
        SELECT
          time_bucket('1 day', started_at) AS day,
          server_user_id,
          server_id,
          media_id,
          MAX(show_media_id::text)::uuid AS show_media_id,
          MAX(media_type) AS media_type,
          COUNT(*) FILTER (WHERE reference_id IS NULL AND COALESCE(duration_ms, 0) >= 120000) AS plays,
          SUM(CASE WHEN duration_ms >= 120000 THEN duration_ms ELSE 0 END) AS watched_ms,
          MAX(progress_ms) AS max_progress_ms,
          MAX(total_duration_ms) AS content_duration_ms,
          BOOL_OR(watched) AS any_watched
        FROM sessions
        WHERE media_id IS NOT NULL
        GROUP BY day, server_user_id, server_id, media_id
        WITH NO DATA
      `,
      refreshPolicy: {
        startOffset: '7 days',
        endOffset: '1 hour',
        scheduleInterval: '15 minutes',
      },
    },
    {
      // Used by: /bandwidth/*
      name: 'daily_bandwidth_by_user',
      sql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS daily_bandwidth_by_user
        WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
        SELECT
          time_bucket('1 day', started_at) AS day,
          server_id,
          server_user_id,
          COUNT(*) AS session_count,
          -- Store the product of bitrate * duration for accurate bandwidth calculation
          -- Formula: SUM(bitrate * duration_ms) / 8 / 1000 = total megabytes transferred
          SUM(COALESCE(bitrate, 0)::bigint * COALESCE(duration_ms, 0)::bigint) AS total_bits_ms,
          AVG(COALESCE(bitrate, 0))::BIGINT AS avg_bitrate,
          MAX(COALESCE(bitrate, 0)) AS peak_bitrate,
          SUM(COALESCE(duration_ms, 0)) AS total_duration_ms
        FROM sessions
        WHERE started_at IS NOT NULL
        GROUP BY day, server_id, server_user_id
        WITH NO DATA
      `,
      refreshPolicy: {
        startOffset: '3 days',
        endOffset: '1 hour',
        scheduleInterval: '1 hour',
      },
    },
    // Library Statistics Aggregates (from library_snapshots hypertable)
    {
      // Used by: /library/growth, /library/quality, /library/storage
      name: 'library_stats_daily',
      // Use MAX() not SUM() - multiple snapshots per day represent the same library state
      // If a library has 1000 items and 3 snapshots exist, SUM would incorrectly produce 3000
      sql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS library_stats_daily
        WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
        SELECT
          time_bucket('1 day', snapshot_time) AS day,
          server_id,
          library_id,
          MAX(item_count) AS total_items,
          MAX(total_size) AS total_size_bytes,
          MAX(movie_count) AS movie_count,
          MAX(episode_count) AS episode_count,
          MAX(show_count) AS show_count,
          MAX(music_count) AS music_count,
          MAX(count_4k) AS count_4k,
          MAX(count_1080p) AS count_1080p,
          MAX(count_720p) AS count_720p,
          MAX(count_sd) AS count_sd,
          MAX(count_high_quality) AS count_high_quality,
          MAX(version_count) AS version_count
        FROM library_snapshots
        GROUP BY day, server_id, library_id
        WITH NO DATA
      `,
      refreshPolicy: {
        startOffset: '7 days',
        endOffset: '1 hour',
        scheduleInterval: '1 hour',
      },
    },
    {
      // Used by: internal/future - tracks quality distribution evolution over time
      name: 'content_quality_daily',
      // Server-level quality and codec metrics for tracking quality evolution over time
      // Use MAX() not SUM() - multiple intra-day snapshots represent the same server state
      sql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS content_quality_daily
        WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
        SELECT
          time_bucket('1 day', snapshot_time) AS day,
          server_id,
          MAX(item_count) AS total_items,
          MAX(count_4k) AS count_4k,
          MAX(count_1080p) AS count_1080p,
          MAX(count_720p) AS count_720p,
          MAX(count_sd) AS count_sd,
          MAX(hevc_count) AS hevc_count,
          MAX(h264_count) AS h264_count,
          MAX(av1_count) AS av1_count,
          MAX(count_high_quality) AS count_high_quality,
          MAX(version_count) AS version_count
        FROM library_snapshots
        GROUP BY day, server_id
        WITH NO DATA
      `,
      refreshPolicy: {
        startOffset: '7 days',
        endOffset: '1 hour',
        scheduleInterval: '1 hour',
      },
    },
  ];
}

/**
 * Check if a continuous aggregate exists
 */
async function continuousAggregateExists(name: string): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT 1 FROM timescaledb_information.continuous_aggregates
      WHERE view_name = ${name}
    `);
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Create a single continuous aggregate from its definition.
 *
 * Note: We check existence before creating because TimescaleDB's
 * CREATE MATERIALIZED VIEW IF NOT EXISTS doesn't work properly with
 * continuous aggregates - it throws "invalid continuous aggregate view"
 * instead of being a no-op when the view already exists.
 */
// Library aggregates that require library_snapshots to be a hypertable
const LIBRARY_AGGREGATES = ['library_stats_daily', 'content_quality_daily'];

async function createAggregate(def: AggregateDefinition, skipLibraryInit = false): Promise<void> {
  // Check if aggregate already exists - skip if so
  const exists = await continuousAggregateExists(def.name);
  if (exists) {
    return;
  }

  // Library aggregates require library_snapshots to be a hypertable
  // skipLibraryInit prevents infinite recursion: createAggregate -> initLibrarySnapshotsHypertable -> createLibraryAggregates -> createAggregate
  if (LIBRARY_AGGREGATES.includes(def.name) && !skipLibraryInit) {
    await initLibrarySnapshotsHypertable();
  }

  try {
    await db.execute(sql.raw(def.sql));
  } catch (error) {
    console.error(`[TimescaleDB] Failed to create aggregate ${def.name}:`, error);
    throw error;
  }
}

/**
 * Add refresh policy for a single aggregate
 */
async function addRefreshPolicy(def: AggregateDefinition): Promise<void> {
  await db.execute(
    sql.raw(`
    SELECT add_continuous_aggregate_policy('${def.name}',
      start_offset => INTERVAL '${def.refreshPolicy.startOffset}',
      end_offset => INTERVAL '${def.refreshPolicy.endOffset}',
      schedule_interval => INTERVAL '${def.refreshPolicy.scheduleInterval}',
      if_not_exists => true
    )
  `)
  );
}

export interface TimescaleStatus {
  extensionInstalled: boolean;
  sessionsIsHypertable: boolean;
  compressionEnabled: boolean;
  continuousAggregates: string[];
  chunkCount: number;
}

/**
 * Check if TimescaleDB extension is available
 */
async function isTimescaleInstalled(): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT EXISTS(
        SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
      ) as installed
    `);
    return (result.rows[0] as { installed: boolean })?.installed ?? false;
  } catch {
    return false;
  }
}

/**
 * Check if sessions table is already a hypertable
 */
async function isSessionsHypertable(): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT EXISTS(
        SELECT 1 FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'sessions'
      ) as is_hypertable
    `);
    return (result.rows[0] as { is_hypertable: boolean })?.is_hypertable ?? false;
  } catch {
    // If timescaledb_information doesn't exist, extension isn't installed
    return false;
  }
}

/**
 * Get list of existing continuous aggregates
 */
async function getContinuousAggregates(): Promise<string[]> {
  try {
    const result = await db.execute(sql`
      SELECT view_name
      FROM timescaledb_information.continuous_aggregates
      WHERE hypertable_name = 'sessions'
    `);
    return (result.rows as { view_name: string }[]).map((r) => r.view_name);
  } catch {
    return [];
  }
}

/**
 * Get list of existing continuous aggregates for library_snapshots
 */
async function getLibrarySnapshotAggregates(): Promise<string[]> {
  try {
    const result = await db.execute(sql`
      SELECT view_name
      FROM timescaledb_information.continuous_aggregates
      WHERE hypertable_name = 'library_snapshots'
    `);
    return (result.rows as { view_name: string }[]).map((r) => r.view_name);
  } catch {
    return [];
  }
}

/**
 * Check if a materialized view exists (regardless of type)
 */
async function materializedViewExists(viewName: string): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT EXISTS(
        SELECT 1 FROM pg_matviews WHERE matviewname = ${viewName}
      ) as exists
    `);
    return (result.rows[0] as { exists: boolean })?.exists ?? false;
  } catch {
    return false;
  }
}

/**
 * Drop a materialized view if it exists and is NOT a continuous aggregate.
 * This is used to replace regular materialized views created by migrations
 * with TimescaleDB continuous aggregates.
 */
async function dropRegularMaterializedViewIfExists(
  viewName: string,
  continuousAggregates: string[]
): Promise<boolean> {
  // Explicit allow-list validation (defense-in-depth)
  const allowedViews = [
    'daily_plays_by_user',
    'daily_plays_by_server',
    'daily_stats_summary',
    'hourly_concurrent_streams',
    'daily_content_engagement',
    'user_media_plays_daily',
    'daily_bandwidth_by_user',
    'library_stats_daily',
    'content_quality_daily',
  ];

  if (!allowedViews.includes(viewName)) {
    console.warn(`Attempted to drop unexpected view: ${viewName}`);
    return false;
  }

  // Don't drop if it's already a continuous aggregate
  if (continuousAggregates.includes(viewName)) {
    return false;
  }

  // Check if it exists as a regular materialized view
  const exists = await materializedViewExists(viewName);
  if (!exists) {
    return false;
  }

  // Drop it so we can recreate as continuous aggregate
  // Use CASCADE to drop dependent views (they'll be recreated by createContinuousAggregates)
  await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS ${sql.identifier(viewName)} CASCADE`);
  return true;
}

/**
 * Check if compression is enabled on sessions
 */
async function isCompressionEnabled(): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT compression_enabled
      FROM timescaledb_information.hypertables
      WHERE hypertable_name = 'sessions'
    `);
    return (result.rows[0] as { compression_enabled: boolean })?.compression_enabled ?? false;
  } catch {
    return false;
  }
}

/**
 * Check if compression orderby settings are correct
 * Returns true if orderby is explicitly set (not auto-detected)

 */
async function isCompressionOrderbyCorrect(): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT attname, orderby_column_index
      FROM timescaledb_information.compression_settings
      WHERE hypertable_name = 'sessions'
        AND orderby_column_index IS NOT NULL
      ORDER BY orderby_column_index
    `);

    // If no rows have orderby set, TimescaleDB will auto-detect (causes 32-column error)
    if (result.rows.length === 0) {
      return false;
    }

    // Check that started_at is the first orderby column
    const firstOrderby = (result.rows[0] as { attname: string })?.attname;
    return firstOrderby === 'started_at';
  } catch {
    return false;
  }
}

/**
 * Update compression settings to fix orderby column limit issue
 * This is safe to run even if compression is already enabled
 */
async function fixCompressionSettings(): Promise<void> {
  console.log('[TimescaleDB] Fixing compression settings (orderby column limit issue)...');

  // Check for existing compressed chunks that may have old settings
  const compressedResult = await db.execute(sql`
    SELECT COUNT(*)::int as count
    FROM timescaledb_information.chunks
    WHERE hypertable_name = 'sessions' AND is_compressed = true
  `);
  const compressedCount = (compressedResult.rows[0] as { count: number })?.count ?? 0;

  if (compressedCount > 0) {
    console.warn(
      `[TimescaleDB] Warning: ${compressedCount} compressed chunks exist with old settings. ` +
        'New chunks will use correct settings. If you see compression errors for old chunks, ' +
        "run: SELECT decompress_chunk(c) FROM show_chunks('sessions') c WHERE is_compressed;"
    );
  }

  // Remove existing policy first
  await db.execute(sql`
    SELECT remove_compression_policy('sessions', if_exists => true)
  `);

  // Update compression settings with explicit orderby
  await db.execute(sql`
    ALTER TABLE sessions SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'server_user_id, server_id',
      timescaledb.compress_orderby = 'started_at DESC, id'
    )
  `);

  // Re-add compression policy
  await db.execute(sql`
    SELECT add_compression_policy('sessions', INTERVAL '7 days', if_not_exists => true)
  `);

  console.log('[TimescaleDB] Compression settings fixed successfully');
}

/**
 * Get chunk count for sessions hypertable
 */
async function getChunkCount(): Promise<number> {
  try {
    const result = await db.execute(sql`
      SELECT count(*)::int as count
      FROM timescaledb_information.chunks
      WHERE hypertable_name = 'sessions'
    `);
    return (result.rows[0] as { count: number })?.count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Ensure the timescale_metadata table exists for storing schema version
 */
async function ensureMetadataTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS timescale_metadata (
      key VARCHAR(255) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

/**
 * Get the stored aggregate schema version
 * Returns 0 if no version is stored (first run or legacy install)
 */
async function getStoredSchemaVersion(): Promise<number> {
  try {
    await ensureMetadataTable();
    const result = await db.execute(sql`
      SELECT value FROM timescale_metadata WHERE key = 'aggregate_schema_version'
    `);
    const value = (result.rows[0] as { value: string })?.value;
    return value ? parseInt(value, 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * Store the current aggregate schema version
 */
async function setStoredSchemaVersion(version: number): Promise<void> {
  await ensureMetadataTable();
  await db.execute(sql`
    INSERT INTO timescale_metadata (key, value, updated_at)
    VALUES ('aggregate_schema_version', ${version.toString()}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `);
}

const BACKFILL_MARKER_KEY = 'aggregate_backfill_pending';

export interface AggregateBackfillMarker {
  targetVersion: number;
  startedAt: string;
}

/**
 * Get the pending aggregate backfill marker, if any.
 * Present when a version-mismatch DDL rebuild has run but the full historical
 * refresh (safeFullRefreshAllAggregates) hasn't completed successfully yet.
 */
export async function getBackfillMarker(): Promise<AggregateBackfillMarker | null> {
  try {
    await ensureMetadataTable();
    const result = await db.execute(sql`
      SELECT value FROM timescale_metadata WHERE key = ${BACKFILL_MARKER_KEY}
    `);
    const value = (result.rows[0] as { value: string } | undefined)?.value;
    if (!value) return null;
    return JSON.parse(value) as AggregateBackfillMarker;
  } catch {
    return null;
  }
}

// Resumable only if the marker already targets this exact version and every expected aggregate view is present; otherwise the views may still be shaped for the old version and need a real rebuild.
export function shouldResumeBackfillInsteadOfRebuild(
  marker: AggregateBackfillMarker | null,
  targetVersion: number,
  missingAggregateCount: number
): boolean {
  return marker !== null && marker.targetVersion === targetVersion && missingAggregateCount === 0;
}

async function setBackfillMarker(targetVersion: number): Promise<void> {
  await ensureMetadataTable();
  const marker: AggregateBackfillMarker = { targetVersion, startedAt: new Date().toISOString() };
  await db.execute(sql`
    INSERT INTO timescale_metadata (key, value, updated_at)
    VALUES (${BACKFILL_MARKER_KEY}, ${JSON.stringify(marker)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `);
}

async function clearBackfillMarker(): Promise<void> {
  await db.execute(sql`
    DELETE FROM timescale_metadata WHERE key = ${BACKFILL_MARKER_KEY}
  `);
}

/**
 * Convert sessions table to hypertable
 * This is idempotent - if_not_exists ensures it won't fail if already a hypertable
 */
async function convertToHypertable(): Promise<void> {
  // First, we need to handle the primary key change
  // TimescaleDB requires the partition column (started_at) in the primary key

  // Check if we need to modify the primary key
  const pkResult = await db.execute(sql`
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE table_name = 'sessions'
    AND constraint_type = 'PRIMARY KEY'
  `);

  const pkName = (pkResult.rows[0] as { constraint_name: string })?.constraint_name;

  // Check if started_at is already in the primary key
  const pkColsResult = await db.execute(sql`
    SELECT column_name
    FROM information_schema.key_column_usage
    WHERE table_name = 'sessions'
    AND constraint_name = ${pkName}
  `);

  const pkColumns = (pkColsResult.rows as { column_name: string }[]).map((r) => r.column_name);

  if (!pkColumns.includes('started_at')) {
    // Need to modify primary key for hypertable conversion

    // Drop FK constraint from automation_runs if it exists. The constraint keeps its
    // pre-rename name: migrations 0000-0089 create it under that name on fresh installs.
    await db.execute(sql`
      ALTER TABLE "automation_runs" DROP CONSTRAINT IF EXISTS "violations_session_id_sessions_id_fk"
    `);

    // Drop existing primary key
    // Note: pkName comes from pg_catalog query, validated as identifier
    if (pkName && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pkName)) {
      await db.execute(
        sql`ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS ${sql.identifier(pkName)}`
      );
    }

    // Add composite primary key
    await db.execute(sql`
      ALTER TABLE "sessions" ADD PRIMARY KEY ("id", "started_at")
    `);

    // Add index for run session lookup (since we can't have FK to hypertable)
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "automation_runs_session_lookup_idx" ON "automation_runs" ("session_id")
    `);
  }

  // Convert to hypertable. 30-day chunks keep chunk fan-out low: at observed
  // volumes even large installs stay well under a million rows per chunk, while
  // the poller's 7-day-bounded lookups still exclude by time.
  await db.execute(sql`
    SELECT create_hypertable('sessions', 'started_at',
      chunk_time_interval => INTERVAL '30 days',
      migrate_data => true,
      if_not_exists => true
    )
  `);

  // Create expression indexes for COALESCE(reference_id, id) pattern
  // This pattern is used throughout the codebase for play grouping
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sessions_play_id
    ON sessions ((COALESCE(reference_id, id)))
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sessions_time_play_id
    ON sessions (started_at DESC, (COALESCE(reference_id, id)))
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sessions_user_play_id
    ON sessions (server_user_id, (COALESCE(reference_id, id)))
  `);
}

/**
 * Create partial indexes for common filtered queries
 * These reduce scan size by excluding irrelevant rows
 */
async function createPartialIndexes(): Promise<void> {
  // Partial index for geo queries (excludes NULL rows - ~20% savings)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sessions_geo_partial
    ON sessions (geo_lat, geo_lon, started_at DESC)
    WHERE geo_lat IS NOT NULL AND geo_lon IS NOT NULL
  `);

  // The two unacked partials predate the runs table: diagnostics are all unacked
  // and outnumber violations 20:1, so the predicate stopped selecting anything and
  // the planner abandoned them. The alias partial in schema.ts serves both reads.
  await db.execute(sql`DROP INDEX IF EXISTS idx_automation_runs_unacked_partial`);
  await db.execute(sql`DROP INDEX IF EXISTS idx_automation_runs_unacked_list`);

  // idx_sessions_active_partial removed - live "now playing" reads come from the
  // Redis cache, and the one matching query (violations detail) plans onto the
  // server_user time index instead

  // Partial index for the stale-session sweep: open rows only, so the
  // sweep's lastSeenAt filter never seq-scans the current 30-day chunk
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sessions_open_last_seen
    ON sessions (last_seen_at)
    WHERE stopped_at IS NULL
  `);

  // The dismissed-only index served a retention purge keyed on dismissed_at;
  // run retention filters on kind and finished_at, and no other read wants it
  await db.execute(sql`DROP INDEX IF EXISTS idx_automation_runs_dismissed_partial`);

  // Partial index for transcoded sessions (quality analysis)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sessions_transcode_partial
    ON sessions (started_at DESC, quality, bitrate)
    WHERE is_transcode = true
  `);

  // Partial index for music track queries (artist, album lookups)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sessions_music_partial
    ON sessions (started_at DESC, artist_name, album_name)
    WHERE media_type = 'track'
  `);

  // Partial index for live TV queries (channel lookups)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sessions_live_tv_partial
    ON sessions (started_at DESC, channel_identifier, channel_title)
    WHERE media_type = 'live'
  `);
}

/**
 * Create optimized indexes for top content queries
 * Time-prefixed indexes enable efficient time-filtered aggregations
 */
async function createContentIndexes(): Promise<void> {
  // idx_sessions_media_time removed - idx_sessions_top_content_covering leads with
  // the same started_at DESC and carries media_title/media_type, so it serves the
  // same time-range shapes

  // Time-prefixed index for show/episode queries (excludes NULLs)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sessions_show_time
    ON sessions (started_at DESC, grandparent_title, season_number, episode_number)
    WHERE grandparent_title IS NOT NULL
  `);

  // Covering index for top content query (includes frequently accessed columns)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sessions_top_content_covering
    ON sessions (started_at DESC, media_title, media_type)
    INCLUDE (duration_ms, server_user_id)
  `);

  // Device tracking index for device velocity rule
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sessions_device_tracking
    ON sessions (server_user_id, started_at DESC, device_id, ip_address)
  `);
}

/**
 * Check if TimescaleDB Toolkit is installed
 */
async function isToolkitInstalled(): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT EXISTS(
        SELECT 1 FROM pg_extension WHERE extname = 'timescaledb_toolkit'
      ) as installed
    `);
    return (result.rows[0] as { installed: boolean })?.installed ?? false;
  } catch {
    return false;
  }
}

/**
 * Check if TimescaleDB Toolkit is available to be installed on the system
 */
async function isToolkitAvailableOnSystem(): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT EXISTS(
        SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb_toolkit'
      ) as available
    `);
    return (result.rows[0] as { available: boolean })?.available ?? false;
  } catch {
    return false;
  }
}

/**
 * Create continuous aggregates for library statistics
 *
 * Library aggregates (library_stats_daily, content_quality_daily) use simple
 * MAX() aggregation and don't require HyperLogLog. They're created separately
 * from session aggregates and integrated into initLibrarySnapshotsHypertable.
 */
async function createLibraryAggregates(): Promise<void> {
  const definitions = getAggregateDefinitions();

  // Filter to library-specific aggregates (based on library_snapshots hypertable)
  const libraryAggregates = definitions.filter(
    (def) => def.name === 'library_stats_daily' || def.name === 'content_quality_daily'
  );

  // skipLibraryInit=true to prevent infinite recursion (we're already in library init)
  for (const def of libraryAggregates) {
    await createAggregate(def, true);
  }
}

/** Create continuous aggregates for dashboard performance */
async function createContinuousAggregates(): Promise<void> {
  const definitions = getAggregateDefinitions();

  // Drop old unused aggregates
  await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS daily_plays_by_platform CASCADE`);
  await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS daily_play_patterns CASCADE`);
  await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS hourly_play_patterns CASCADE`);

  for (const def of definitions) {
    await createAggregate(def);
  }
}

/** Set up refresh policies for continuous aggregates */
async function setupRefreshPolicies(): Promise<void> {
  const definitions = getAggregateDefinitions();
  for (const def of definitions) {
    await addRefreshPolicy(def);
  }
}

/**
 * Enable compression on sessions hypertable
 */
async function enableCompression(): Promise<void> {
  // Enable compression settings
  // Note: compress_orderby is explicitly set to avoid TimescaleDB auto-detecting
  // too many columns (>32), which fails with "cannot use more than 32 columns in an index"
  await db.execute(sql`
    ALTER TABLE sessions SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'server_user_id, server_id',
      timescaledb.compress_orderby = 'started_at DESC, id'
    )
  `);

  // Add compression policy (compress chunks older than 7 days)
  await db.execute(sql`
    SELECT add_compression_policy('sessions', INTERVAL '7 days', if_not_exists => true)
  `);
}

const COMPRESSION_POLICY_DEGRADED_KEY = 'sessions_compression_policy_degraded';

// The persisted flag in timescale_metadata stays the source of truth (it
// survives restarts and spans instances), but the health interval reads it
// every 10s and the healthy answer never changes on its own. Cache the
// healthy answer briefly; a local mark bypasses the cache entirely so the
// instance that broke the policy retries every tick until healed. The only
// cost is cross-instance heal latency moving from 10s to the TTL, against a
// compression job that fires every 12 hours.
const DEGRADED_CHECK_TTL_MS = 10 * 60 * 1000;
let degradedLocalHint = false;
let degradedCache: { value: boolean; checkedAt: number } | null = null;

export function _resetDegradedCacheForTests(): void {
  degradedLocalHint = false;
  degradedCache = null;
}

async function markCompressionPolicyDegraded(reason: string): Promise<void> {
  degradedLocalHint = true;
  degradedCache = null;
  try {
    await ensureMetadataTable();
    await db.execute(sql`
      INSERT INTO timescale_metadata (key, value, updated_at)
      VALUES (${COMPRESSION_POLICY_DEGRADED_KEY}, ${reason}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `);
  } catch (err) {
    console.error('[TimescaleDB] Failed to persist compression-policy-degraded flag:', err);
  }
}

async function clearCompressionPolicyDegraded(): Promise<void> {
  degradedLocalHint = false;
  degradedCache = { value: false, checkedAt: Date.now() };
  try {
    await db.execute(
      sql`DELETE FROM timescale_metadata WHERE key = ${COMPRESSION_POLICY_DEGRADED_KEY}`
    );
  } catch (err) {
    console.warn('[TimescaleDB] Failed to clear compression-policy-degraded flag:', err);
  }
}

/**
 * Whether a previous restore of the sessions compression policy failed and
 * hasn't self-healed yet. Persisted (not in-memory) so it survives a restart
 * and stays visible to every instance in a multi-instance deployment; the
 * healthy answer is cached in-process for DEGRADED_CHECK_TTL_MS so the
 * 10-second health interval doesn't re-ask the database.
 */
export async function isCompressionPolicyDegraded(): Promise<boolean> {
  if (degradedLocalHint) return true;
  if (degradedCache && Date.now() - degradedCache.checkedAt < DEGRADED_CHECK_TTL_MS) {
    return degradedCache.value;
  }
  try {
    await ensureMetadataTable();
    const result = await db.execute(
      sql`SELECT 1 FROM timescale_metadata WHERE key = ${COMPRESSION_POLICY_DEGRADED_KEY}`
    );
    const value = result.rows.length > 0;
    degradedCache = { value, checkedAt: Date.now() };
    return value;
  } catch {
    return false;
  }
}

async function addSessionsCompressionPolicy(): Promise<void> {
  await db.execute(
    sql`SELECT add_compression_policy('sessions', INTERVAL '7 days', if_not_exists => true)`
  );
}

/**
 * Periodically re-checked (from the DB health check interval in index.ts) to
 * retry restoring the sessions compression policy if a previous attempt left
 * it degraded. Self-heals a transient failure (e.g. the DB was briefly
 * unreachable right when withSessionsCompressionPaused tried to restore it)
 * without needing an operator to run the recovery command by hand.
 */
export async function retryDegradedCompressionPolicy(): Promise<void> {
  if (!(await isCompressionPolicyDegraded())) return;
  try {
    await addSessionsCompressionPolicy();
    console.log('[TimescaleDB] Sessions compression policy self-healed on retry');
    await clearCompressionPolicyDegraded();
  } catch (err) {
    console.warn('[TimescaleDB] Sessions compression policy still degraded, will retry:', err);
  }
}

export async function withSessionsCompressionPaused<T>(
  fn: () => Promise<T>,
  /** Delay before the single retry attempt. Overridable in tests to avoid a real sleep. */
  retryDelayMs = 5000
): Promise<T> {
  let paused = false;
  try {
    await db.execute(sql`SELECT remove_compression_policy('sessions', if_exists => true)`);
    paused = true;
    console.log('[TimescaleDB] Sessions compression policy paused');
  } catch (err) {
    console.warn(
      '[TimescaleDB] Could not pause sessions compression policy, proceeding without pause:',
      err
    );
  }

  try {
    return await fn();
  } finally {
    if (paused) {
      try {
        await addSessionsCompressionPolicy();
        console.log('[TimescaleDB] Sessions compression policy restored');
      } catch (err) {
        console.warn(
          `[TimescaleDB] Failed to restore sessions compression policy, retrying once in ${retryDelayMs}ms:`,
          err
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        try {
          await addSessionsCompressionPolicy();
          console.log('[TimescaleDB] Sessions compression policy restored on retry');
        } catch (retryErr) {
          // Leaving the policy off means old chunks never compress. Mark it degraded so
          // retryDegradedCompressionPolicy (called from the DB health interval) keeps
          // retrying in the background, and surface a recovery command in case an
          // operator wants to run it by hand instead of waiting.
          console.error(
            '[TimescaleDB] CRITICAL: failed to restore sessions compression policy after a retry. ' +
              "Run: SELECT add_compression_policy('sessions', INTERVAL '7 days', if_not_exists => true)",
            retryErr
          );
          await markCompressionPolicyDegraded(
            retryErr instanceof Error ? retryErr.message : String(retryErr)
          );
        }
      }
    }
  }
}

export interface ChunkTimeRange {
  start: Date;
  end: Date;
}

/**
 * Time ranges of compressed sessions chunks, newest first. Empty when
 * TimescaleDB is absent or nothing is compressed yet. Callers window DML to
 * one range at a time so tuple decompression per transaction stays bounded
 * by a single chunk's segments.
 */
export async function getCompressedSessionChunkRanges(): Promise<ChunkTimeRange[]> {
  if (!(await isTimescaleInstalled())) return [];
  const result = await db.execute(sql`
    SELECT range_start, range_end
    FROM timescaledb_information.chunks
    WHERE hypertable_name = 'sessions' AND is_compressed = true
    ORDER BY range_end DESC
  `);
  // node-postgres parses timestamptz to Date, but a raw execute can hand back
  // either depending on the driver path - new Date() accepts both.
  return (result.rows as Array<{ range_start: string | Date; range_end: string | Date }>).map(
    (r) => ({
      start: new Date(r.range_start),
      end: new Date(r.range_end),
    })
  );
}

/**
 * started_at bound above which no sessions chunk is compressed - null when
 * nothing is compressed (or TimescaleDB is absent). Convenience for one-shot
 * callers that only need the boundary, not the per-chunk ranges.
 */
export async function getSessionsCompressionHorizon(): Promise<Date | null> {
  if (!(await isTimescaleInstalled())) return null;
  const result = await db.execute(sql`
    SELECT max(range_end) AS horizon
    FROM timescaledb_information.chunks
    WHERE hypertable_name = 'sessions' AND is_compressed = true
  `);
  const horizon = (result.rows[0] as { horizon: string | Date | null } | undefined)?.horizon;
  return horizon ? new Date(horizon) : null;
}

export const MAX_TUPLES_DECOMPRESSED_GUC =
  'timescaledb.max_tuples_decompressed_per_dml_transaction';

/**
 * Lift the per-transaction decompression cap inside one drizzle transaction.
 * SET LOCAL dies with the transaction, so nothing leaks back to the pool.
 * The GUC only exists when the timescaledb extension is loaded; on plain
 * postgres this is a no-op. The global-unlimited version of this setting is
 * what let runtime DML OOM postgres - callers get it per-transaction only.
 */
export async function uncapDecompressionForTx(tx: {
  execute: (query: SQL) => Promise<{ rows: unknown[] }>;
}): Promise<void> {
  const guc = await tx.execute(
    sql`SELECT 1 FROM pg_settings WHERE name = ${MAX_TUPLES_DECOMPRESSED_GUC}`
  );
  if (guc.rows.length > 0) {
    await tx.execute(sql.raw(`SET LOCAL ${MAX_TUPLES_DECOMPRESSED_GUC} = 0`));
  }
}

/**
 * Session-scoped variant for dedicated non-pooled clients (migrations): plain
 * SET, which dies with the connection. Never use on a pooled connection - an
 * uncapped session returned to the pool keeps the cap off for whoever gets it
 * next; pooled callers use uncapDecompressionForTx (SET LOCAL) instead.
 */
export async function uncapDecompressionForSession(client: pg.Client): Promise<void> {
  const guc = await client.query('SELECT 1 FROM pg_settings WHERE name = $1', [
    MAX_TUPLES_DECOMPRESSED_GUC,
  ]);
  if ((guc.rowCount ?? 0) > 0) {
    await client.query(`SET ${MAX_TUPLES_DECOMPRESSED_GUC} = 0`);
  }
}

/**
 * Options for refreshing continuous aggregates
 */
export interface RefreshAggregatesOptions {
  /**
   * If true, refresh entire aggregate history (expensive - scans all chunks).
   * Use for bulk imports or backfill scenarios.
   * Default: false (uses time-bounded refresh for recent data only)
   */
  fullRefresh?: boolean;
  /**
   * Start of time range to refresh. Only used if fullRefresh is false.
   * Floored to the containing UTC day, since the aggregates bucket daily.
   * Default: 7 days ago
   */
  startTime?: Date;
  /**
   * End of time range to refresh. Floored to the containing UTC day; a window
   * that collapses to zero width is skipped. The DEFAULT (now + 1 day) floors
   * to tomorrow midnight, deliberately spanning today's in-flight bucket -
   * import flows accept that watermark advance. Callers that must not
   * materialize today's bucket pass an explicit end (see initTimescaleDB's
   * startOfTodayUtc cap).
   * Default: now + 1 day
   */
  endTime?: Date;
}

/**
 * Coerces a refresh-window bound to a valid Date, falling back to the given
 * default (and logging loudly) when the input is missing or unparseable.
 * Some callers source these from raw db.execute results, which return
 * timestamptz columns as strings rather than Date objects, so an invalid
 * value here must not fail silently the way the coercion it replaces did.
 */
export function coerceRefreshBound(
  value: Date | string | undefined,
  fallback: Date,
  label: string
): Date {
  const coerced = new Date(value ?? fallback);
  if (Number.isNaN(coerced.getTime())) {
    console.error(
      `[TimescaleDB] Invalid ${label} for aggregate refresh (received: ${String(value)}), falling back to default`
    );
    return fallback;
  }
  return coerced;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Floor to the UTC-midnight bucket boundary. Every managed continuous
 * aggregate buckets by UTC day, and refresh_continuous_aggregate rejects
 * windows narrower than one bucket ("refresh window too small") - so refresh
 * bounds are floored to whole UTC days, and a window that collapses to zero
 * width is skipped by callers: its sub-day tail is served by real-time
 * aggregation and must NOT be materialized (see the refresh-policy comment
 * below re advancing the watermark through today's bucket).
 */
export function floorToUtcDay(d: Date): Date {
  return new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);
}

/**
 * Align a refresh window to whole UTC-day buckets, flooring both ends.
 * Returns null when nothing bucket-complete remains to refresh - callers
 * skip the refresh entirely (real-time aggregation covers the tail).
 */
export function alignRefreshWindow(start: Date, end: Date): { start: Date; end: Date } | null {
  const alignedStart = floorToUtcDay(start);
  const alignedEnd = floorToUtcDay(end);
  if (alignedEnd.getTime() <= alignedStart.getTime()) return null;
  return { start: alignedStart, end: alignedEnd };
}

/**
 * Refresh a specific list of continuous aggregates over a time range.
 * Shared by refreshAggregates (sessions hypertable) and
 * refreshLibrarySnapshotAggregates (library_snapshots hypertable) - the two
 * hypertables have disjoint aggregate lists, so callers pick which to refresh.
 */
async function refreshAggregateList(
  aggregates: string[],
  options?: RefreshAggregatesOptions
): Promise<void> {
  const fullRefresh = options?.fullRefresh ?? false;

  // Default time bounds: last 7 days to tomorrow
  const defaultStart = new Date(Date.now() - 7 * DAY_MS);
  const defaultEnd = new Date(Date.now() + DAY_MS);
  const startTime = coerceRefreshBound(options?.startTime, defaultStart, 'startTime');
  const endTime = coerceRefreshBound(options?.endTime, defaultEnd, 'endTime');

  // A full refresh passes NULL bounds, so it needs no window at all.
  const window = fullRefresh ? null : alignRefreshWindow(startTime, endTime);
  if (!fullRefresh && !window) {
    console.log(
      `[TimescaleDB] Refresh window ${startTime.toISOString()} → ${endTime.toISOString()} has no complete UTC-day bucket - skipping, real-time aggregation covers it`
    );
    return;
  }

  for (const aggregate of aggregates) {
    try {
      if (window) {
        // Time-bounded refresh - only scans relevant chunks (default)
        // Must use explicit timestamptz cast - CALL statements don't infer parameter types
        const startStr = window.start.toISOString();
        const endStr = window.end.toISOString();
        await db.execute(
          sql`CALL refresh_continuous_aggregate(${aggregate}::regclass, ${startStr}::timestamptz, ${endStr}::timestamptz)`
        );
      } else {
        // Full refresh - scans all chunks (expensive, use for backfill)
        await db.execute(
          sql`CALL refresh_continuous_aggregate(${aggregate}::regclass, NULL, NULL)`
        );
      }
    } catch (err) {
      // Log but don't fail - aggregate might not have data yet
      console.warn(`Failed to refresh aggregate ${aggregate}:`, err);
    }
  }
}

/**
 * Manually refresh all continuous aggregates on the sessions hypertable.
 *
 * By default, uses time-bounded refresh (last 7 days) to avoid lock exhaustion.
 * For bulk imports/backfill, pass { fullRefresh: true } to refresh entire history.
 *
 * @param options - Refresh options (fullRefresh, startTime, endTime)
 */
export async function refreshAggregates(options?: RefreshAggregatesOptions): Promise<void> {
  const hasExtension = await isTimescaleInstalled();
  if (!hasExtension) return;

  const aggregates = await getContinuousAggregates();
  await refreshAggregateList(aggregates, options);
}

/**
 * Manually refresh all continuous aggregates on the library_snapshots
 * hypertable (library_stats_daily, content_quality_daily). These are not
 * covered by refreshAggregates, which only looks at the sessions hypertable.
 *
 * @param options - Refresh options (fullRefresh, startTime, endTime)
 */
export async function refreshLibrarySnapshotAggregates(
  options?: RefreshAggregatesOptions
): Promise<void> {
  const hasExtension = await isTimescaleInstalled();
  if (!hasExtension) return;

  const aggregates = await getLibrarySnapshotAggregates();
  await refreshAggregateList(aggregates, options);
}

/**
 * Options for safe batched aggregate refresh
 */
export interface SafeRefreshOptions {
  /** Days per batch (default: 30) */
  batchDays?: number;
  /** Milliseconds delay between batches (default: 2000) */
  delayBetweenBatches?: number;
  /** Progress callback */
  onProgress?: (progress: AggregateRefreshProgress) => void;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

/**
 * Progress information for aggregate refresh
 */
export interface AggregateRefreshProgress {
  aggregate: string;
  totalAggregates: number;
  currentAggregateIndex: number;
  startDate: string;
  endDate: string;
  currentBatchStart: string;
  currentBatchEnd: string;
  percentComplete: number;
  status: 'running' | 'paused' | 'completed' | 'error';
}

/**
 * Get the date range of actual data in the database
 * Clamps earliest date to MIN_VALID_YEAR to avoid processing bogus historical data
 * (e.g., Emby sometimes returns dates like year 0001 for items with missing metadata)
 */
const MIN_VALID_YEAR = 2015;

async function getDataDateRange(): Promise<{ earliest: Date | null; latest: Date | null }> {
  const result = await db.execute(sql`
    SELECT
      LEAST(
        (SELECT MIN(started_at) FROM sessions),
        (SELECT MIN(created_at) FROM library_items WHERE file_size > 0 AND removed_at IS NULL)
      ) AS earliest,
      GREATEST(
        (SELECT MAX(started_at) FROM sessions),
        NOW()
      ) AS latest
  `);

  const row = result.rows[0] as { earliest: string | null; latest: string | null };

  let earliest: Date | null = row.earliest ? new Date(row.earliest) : null;
  const latest: Date | null = row.latest ? new Date(row.latest) : null;

  // Clamp earliest date to MIN_VALID_YEAR to avoid processing bogus data
  // Bad dates (year 0001, 1970, etc.) would cause massive unnecessary batch processing
  if (earliest && earliest.getFullYear() < MIN_VALID_YEAR) {
    console.warn(
      `[TimescaleDB] Earliest date ${earliest.toISOString()} is before ${MIN_VALID_YEAR}, clamping to Jan 1 ${MIN_VALID_YEAR}`
    );
    earliest = new Date(Date.UTC(MIN_VALID_YEAR, 0, 1));
  }

  return { earliest, latest };
}

/**
 * Get list of active aggregate names (those we actually manage).
 * Exported for use in debug routes and other places that need the list.
 */
export function getActiveAggregateNames(): string[] {
  return getAggregateDefinitions().map((def) => def.name);
}

/** A single batch that failed to refresh, identified by its aggregate and time range. */
export interface FailedRefreshBatch {
  aggregate: string;
  startDate: string;
  endDate: string;
  error: unknown;
}

/**
 * Safely refresh a single aggregate using batched processing.
 * This prevents memory exhaustion by processing in small time windows.
 *
 * A batch failure doesn't stop the loop - it still attempts every remaining
 * batch so a single bad range can't block the rest of history - but every
 * failure is collected and returned so the caller can decide whether the run
 * as a whole succeeded. Returns an empty array when every batch refreshed.
 *
 * @param aggregateName - Name of the aggregate to refresh
 * @param startDate - Start of date range
 * @param endDate - End of date range
 * @param options - Refresh options
 */
export async function safeFullRefreshAggregate(
  aggregateName: string,
  startDate: Date,
  endDate: Date,
  options: SafeRefreshOptions = {}
): Promise<FailedRefreshBatch[]> {
  const { batchDays = 30, delayBetweenBatches = 2000, onProgress, signal } = options;

  const window = alignRefreshWindow(startDate, endDate);
  if (!window) {
    console.log(
      `[TimescaleDB] Refresh window ${startDate.toISOString()} → ${endDate.toISOString()} has no complete UTC-day bucket - skipping ${aggregateName}, real-time aggregation covers it`
    );
    return [];
  }
  const { start: alignedStart, end: alignedEnd } = window;

  const totalDays = Math.ceil((alignedEnd.getTime() - alignedStart.getTime()) / DAY_MS);
  // Ensure at least 1 batch to prevent division by zero in progress calculation
  const totalBatches = Math.max(1, Math.ceil(totalDays / batchDays));

  let currentBatch = 0;
  let batchStart = new Date(alignedStart);
  const failedBatches: FailedRefreshBatch[] = [];

  console.log(
    `[TimescaleDB] Safe refresh ${aggregateName}: ${totalDays} days in ${totalBatches} batches`
  );

  while (batchStart < alignedEnd) {
    // Check for cancellation
    if (signal?.aborted) {
      throw new Error('Refresh cancelled');
    }

    const batchEnd = new Date(
      Math.min(batchStart.getTime() + batchDays * DAY_MS, alignedEnd.getTime())
    );

    // Refresh this batch
    try {
      // Must use explicit timestamptz cast - CALL statements don't infer parameter types
      const startStr = batchStart.toISOString();
      const endStr = batchEnd.toISOString();
      await db.execute(
        sql`CALL refresh_continuous_aggregate(${aggregateName}::regclass, ${startStr}::timestamptz, ${endStr}::timestamptz)`
      );
    } catch (err) {
      console.warn(`[TimescaleDB] Batch refresh failed for ${aggregateName}:`, err);
      // Continue to next batch rather than failing entirely, but remember it happened.
      failedBatches.push({
        aggregate: aggregateName,
        startDate: batchStart.toISOString(),
        endDate: batchEnd.toISOString(),
        error: err,
      });
    }

    currentBatch++;

    // Report progress
    onProgress?.({
      aggregate: aggregateName,
      totalAggregates: 1,
      currentAggregateIndex: 0,
      startDate: alignedStart.toISOString(),
      endDate: alignedEnd.toISOString(),
      currentBatchStart: batchStart.toISOString(),
      currentBatchEnd: batchEnd.toISOString(),
      percentComplete: Math.round((currentBatch / totalBatches) * 100),
      status: 'running',
    });

    // Move to next batch
    batchStart = batchEnd;

    // Delay between batches to let system breathe
    if (batchStart < alignedEnd && delayBetweenBatches > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
    }
  }

  return failedBatches;
}

/**
 * Safely refresh ALL aggregates using batched processing.
 * This is the safe alternative to fullRefresh: true for full history rebuilds.
 *
 * Features:
 * - Processes one aggregate at a time
 * - Each aggregate is processed in 30-day batches
 * - 2-second delay between batches prevents lock exhaustion
 * - Progress tracking via callback
 * - Cancellable via AbortSignal
 *
 * Every aggregate and every batch is still attempted even if earlier ones
 * failed. But if any batch failed, this throws after processing everything,
 * naming every failed range, instead of resolving successfully - callers
 * (runAggregateBackfill) rely on that to avoid marking a partial backfill as
 * complete.
 *
 * @param options - Refresh options
 */
export async function safeFullRefreshAllAggregates(
  options: SafeRefreshOptions = {}
): Promise<void> {
  const { onProgress, signal } = options;

  // Get date range from actual data
  const dateRange = await getDataDateRange();
  if (!dateRange.earliest || !dateRange.latest) {
    console.log('[TimescaleDB] No data to refresh');
    return;
  }

  const aggregates = getActiveAggregateNames();
  console.log(
    `[TimescaleDB] Safe full refresh: ${aggregates.length} aggregates from ${dateRange.earliest.toISOString()} to ${dateRange.latest.toISOString()}`
  );

  const allFailedBatches: FailedRefreshBatch[] = [];

  for (let i = 0; i < aggregates.length; i++) {
    if (signal?.aborted) {
      throw new Error('Refresh cancelled');
    }

    const aggregate = aggregates[i];
    if (!aggregate) continue;

    console.log(`[TimescaleDB] Safe refresh ${i + 1}/${aggregates.length}: ${aggregate}`);

    const failedBatches = await safeFullRefreshAggregate(
      aggregate,
      dateRange.earliest,
      dateRange.latest,
      {
        ...options,
        onProgress: (progress) => {
          onProgress?.({
            ...progress,
            totalAggregates: aggregates.length,
            currentAggregateIndex: i,
            percentComplete: Math.round(
              ((i + progress.percentComplete / 100) / aggregates.length) * 100
            ),
          });
        },
      }
    );
    allFailedBatches.push(...failedBatches);
  }

  if (allFailedBatches.length > 0) {
    const ranges = allFailedBatches
      .map((f) => `${f.aggregate} [${f.startDate} → ${f.endDate}]`)
      .join(', ');
    throw new Error(`Aggregate refresh had ${allFailedBatches.length} failed batch(es): ${ranges}`);
  }

  console.log('[TimescaleDB] Safe full refresh complete');
}

/** Options for runAggregateBackfill */
export interface BackfillRunOptions {
  /** Bounded retry attempts before giving up for this boot (default: 3) */
  maxAttempts?: number;
  /** Delay before the first retry; doubles after each failed attempt (default: 30s) */
  initialDelayMs?: number;
  /** Injectable for tests - avoids waiting on real timers */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests - simulate refresh failures without touching real data */
  refreshFn?: (options?: SafeRefreshOptions) => Promise<void>;
}

/**
 * Advisory lock key gating the background historical aggregate backfill.
 * Multi-instance deployments share one database, so without this, every
 * replica that boots with a pending backfill marker would kick off the same
 * expensive unbounded refresh concurrently. Value is arbitrary but must stay
 * stable across releases (it's just a shared integer both sides agree on -
 * changing it does not migrate or reset anything, it just stops matching
 * a lock already held under the old key).
 */
const BACKFILL_ADVISORY_LOCK_KEY = 875_100_001;

/**
 * Try to acquire the session-scoped backfill advisory lock on a dedicated
 * connection. Deliberately not the pooled `db` client: a pooled connection
 * can be returned to the pool and reused by an unrelated query while this
 * code still believes it holds the lock. Returns the holding client on
 * success (caller must release it via releaseBackfillLock when done), or
 * null if another session already holds the lock. Postgres also releases
 * the lock automatically if this connection closes without an explicit
 * unlock (crash, etc.), so a losing or crashing instance can never wedge it.
 */
async function tryAcquireBackfillLock(): Promise<pg.Client | null> {
  // This connection stays open for the whole backfill, including retry sleeps;
  // the factory's error handler is what keeps a postgres restart underneath it
  // from taking the process down. Note the lock dies with the session: after
  // such a restart this run continues unguarded and a peer can acquire it.
  const client = createRawPgClient('backfill-lock');
  await client.connect();
  const result = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [
    BACKFILL_ADVISORY_LOCK_KEY,
  ]);
  const acquired = (result.rows[0] as { acquired: boolean } | undefined)?.acquired ?? false;
  if (!acquired) {
    await client.end().catch(() => {
      /* ignore cleanup errors */
    });
    return null;
  }
  return client;
}

async function releaseBackfillLock(client: pg.Client): Promise<void> {
  try {
    // The connection may already be dead (postgres restart during a long
    // backfill). The lock died with the session, so a failed unlock must not
    // replace the backfill's own result with a throw.
    await client.query('SELECT pg_advisory_unlock($1)', [BACKFILL_ADVISORY_LOCK_KEY]).catch(() => {
      /* ignore cleanup errors */
    });
  } finally {
    await client.end().catch(() => {
      /* ignore cleanup errors */
    });
  }
}

/**
 * Run the full historical aggregate backfill in the background, after the
 * server has already started listening.
 *
 * Called once a startup version-mismatch DDL rebuild (see initTimescaleDB)
 * has left the aggregates with only a bounded recent window populated. This
 * runs the expensive unbounded refresh (safeFullRefreshAllAggregates) without
 * blocking startup or the deploy platform's startup probe.
 *
 * Guarded by a Postgres session-scoped advisory lock (BACKFILL_ADVISORY_LOCK_KEY)
 * so that in a multi-instance deployment only one replica actually runs the
 * backfill at a time. A replica that fails to acquire the lock returns
 * immediately (`skipped: true`) without touching the marker or the stored
 * schema version - it will re-check the marker on its own next restart, same
 * as today's already-implemented leftover-marker path in initTimescaleDB.
 *
 * On success, clears the backfill marker and stores the new schema version.
 * On failure, retries with backoff up to maxAttempts; if every attempt fails,
 * the marker is left in place (never cleared, never silently dropped) so the
 * next server startup resumes the backfill via initTimescaleDB instead of
 * leaving aggregates with partial history indefinitely.
 *
 * "Success" here means every batch of every aggregate actually refreshed, not
 * just that refreshFn resolved. The default refreshFn (safeFullRefreshAllAggregates
 * -> safeFullRefreshAggregate) still attempts every remaining batch after a
 * failure rather than aborting early, but it now throws (naming every failed
 * range) if any batch failed, so a run that silently lost some batches counts
 * as a failed attempt here - same retry-with-backoff and marker-preservation
 * path as an outright rejection (e.g. a dropped connection).
 */
export async function runAggregateBackfill(
  targetVersion: number,
  options: BackfillRunOptions = {}
): Promise<{ success: boolean; attempts: number; skipped?: boolean }> {
  const {
    maxAttempts = 3,
    initialDelayMs = 30_000,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    refreshFn = safeFullRefreshAllAggregates,
  } = options;

  const lockClient = await tryAcquireBackfillLock();
  if (!lockClient) {
    console.log(
      '[TimescaleDB] Another instance already holds the aggregate backfill lock - ' +
        `skipping for this boot (schema v${targetVersion}). The marker is left in place; ` +
        'this instance will re-check it on its own next restart.'
    );
    return { success: true, attempts: 0, skipped: true };
  }

  try {
    let delay = initialDelayMs;
    let lastLoggedBucket = -1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(
          `[TimescaleDB] Starting historical aggregate backfill (attempt ${attempt}/${maxAttempts}) for schema v${targetVersion}...`
        );
        await refreshFn({
          onProgress: (progress) => {
            const bucket = Math.floor(progress.percentComplete / 20) * 20;
            if (bucket !== lastLoggedBucket) {
              lastLoggedBucket = bucket;
              console.log(
                `[TimescaleDB] Backfill progress: ${bucket}% (${progress.aggregate}, ` +
                  `${progress.currentAggregateIndex + 1}/${progress.totalAggregates})`
              );
            }
          },
        });
        await clearBackfillMarker();
        await setStoredSchemaVersion(targetVersion);
        console.log(
          `[TimescaleDB] Historical aggregate backfill complete - schema version set to ${targetVersion}`
        );
        return { success: true, attempts: attempt };
      } catch (err) {
        const willRetry = attempt < maxAttempts;
        console.error(
          `[TimescaleDB] ERROR: Aggregate backfill attempt ${attempt}/${maxAttempts} failed. ` +
            'Dashboards continue to show recent data only until this completes. ' +
            (willRetry
              ? `Retrying in ${Math.round(delay / 1000)}s.`
              : 'Giving up for this boot - the pending marker is left in place and the ' +
                'next server restart will resume the backfill automatically.'),
          err
        );
        if (willRetry) {
          await sleep(delay);
          delay *= 2;
        }
      }
    }

    return { success: false, attempts: maxAttempts };
  } finally {
    await releaseBackfillLock(lockClient);
  }
}

/**
 * Check if aggregates need a full rebuild (for fresh installs after import)
 * Returns true if aggregates are missing significant historical data
 */
export async function checkAggregateNeedsRebuild(): Promise<{
  needsRebuild: boolean;
  reason?: string;
}> {
  try {
    const result = await db.execute(sql`
      SELECT
        (SELECT MIN(started_at) FROM sessions) AS earliest_session,
        (SELECT MIN(day) FROM daily_content_engagement) AS earliest_aggregate,
        (SELECT COUNT(*) FROM sessions) AS session_count
    `);

    const row = result.rows[0] as {
      earliest_session: string | null;
      earliest_aggregate: string | null;
      session_count: string;
    };

    const sessionCount = parseInt(row.session_count, 10);

    // No sessions = nothing to rebuild
    if (sessionCount === 0 || !row.earliest_session) {
      return { needsRebuild: false };
    }

    // No aggregate data yet = definitely needs rebuild
    if (!row.earliest_aggregate) {
      return { needsRebuild: true, reason: 'No aggregate data exists' };
    }

    const sessionDate = new Date(row.earliest_session);
    const aggregateDate = new Date(row.earliest_aggregate);
    const daysDiff = (aggregateDate.getTime() - sessionDate.getTime()) / (24 * 60 * 60 * 1000);

    // If aggregates are missing more than 7 days of history, trigger rebuild
    if (daysDiff > 7) {
      return {
        needsRebuild: true,
        reason: `Aggregates missing ${Math.round(daysDiff)} days of historical data`,
      };
    }

    return { needsRebuild: false };
  } catch (err) {
    console.warn('[TimescaleDB] Error checking aggregate status:', err);
    return { needsRebuild: false };
  }
}

// The DB health interval calls getTimescaleStatus every 10s; without a cache
// that fans out into four timescaledb_information catalog scans per tick. These
// values only drift on chunk/aggregate topology changes (init, rebuild), which
// invalidate the cache explicitly, so a 5-minute TTL is safe.
const TIMESCALE_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
let timescaleStatusCache: { value: TimescaleStatus; expiresAt: number } | null = null;

/** Drop the cached TimescaleDB status. Call after DDL that changes topology. */
export function invalidateTimescaleStatusCache(): void {
  timescaleStatusCache = null;
}

async function computeTimescaleStatus(): Promise<TimescaleStatus> {
  const extensionInstalled = await isTimescaleInstalled();

  if (!extensionInstalled) {
    return {
      extensionInstalled: false,
      sessionsIsHypertable: false,
      compressionEnabled: false,
      continuousAggregates: [],
      chunkCount: 0,
    };
  }

  return {
    extensionInstalled: true,
    sessionsIsHypertable: await isSessionsHypertable(),
    compressionEnabled: await isCompressionEnabled(),
    continuousAggregates: await getContinuousAggregates(),
    chunkCount: await getChunkCount(),
  };
}

/**
 * Get current TimescaleDB status. Cached in-process for 5 minutes; the catalog
 * queries behind it are otherwise re-run on every DB health tick.
 */
export async function getTimescaleStatus(): Promise<TimescaleStatus> {
  const now = Date.now();
  if (timescaleStatusCache && timescaleStatusCache.expiresAt > now) {
    return timescaleStatusCache.value;
  }

  const value = await computeTimescaleStatus();
  timescaleStatusCache = { value, expiresAt: now + TIMESCALE_STATUS_CACHE_TTL_MS };
  return value;
}

/**
 * Warn when the database image ships a newer extension than the one the
 * database is running. Swapping the image alone never updates the extension,
 * so without this the drift is invisible until something breaks.
 */
export async function warnOnTimescaleVersionDrift(log: {
  warn: (msg: string) => void;
}): Promise<void> {
  const result = await db.execute(sql`
    SELECT name, installed_version, default_version
    FROM pg_available_extensions
    WHERE name IN ('timescaledb', 'timescaledb_toolkit')
      AND installed_version IS NOT NULL
      AND installed_version != default_version
  `);

  for (const row of result.rows as {
    name: string;
    installed_version: string;
    default_version: string;
  }[]) {
    log.warn(
      `TimescaleDB extension "${row.name}" is at ${row.installed_version} but the database ` +
        `image ships ${row.default_version}. Set TIMESCALEDB_AUTO_UPDATE=true to let Tracearr ` +
        `update it at boot, or run as the extension owner: ` +
        `psql -X -d <database> -c 'ALTER EXTENSION ${row.name} UPDATE'`
    );
  }
}

/**
 * Update TimescaleDB extensions to the latest version available on the system.
 *
 * MUST run before migrations or any queries that touch timescaledb objects
 * (e.g. timescaledb_information.*), because once the old extension version is
 * loaded into a PostgreSQL backend session it cannot be updated in that session.
 */
export async function updateTimescaleExtensions(): Promise<void> {
  // Check which extensions need updating (fine to use the pool for this read)
  const result = await db.execute(sql`
    SELECT name, installed_version, default_version
    FROM pg_available_extensions
    WHERE name IN ('timescaledb', 'timescaledb_toolkit')
      AND installed_version IS NOT NULL
      AND installed_version != default_version
  `);

  const extensions = result.rows as {
    name: string;
    installed_version: string;
    default_version: string;
  }[];
  if (extensions.length === 0) return;

  // ALTER EXTENSION must be the FIRST statement in a PostgreSQL session. TimescaleDB's
  // hooks fire on any prior query (even SELECT 1), marking the old version as "loaded"
  // in the backend, which blocks the update. A fresh connection avoids this.
  const client = createRawPgClient('extension-update');
  try {
    await client.connect();
    for (const row of extensions) {
      console.info(
        `[TimescaleDB] Updating extension ${row.name} from ${row.installed_version} to ${row.default_version}`
      );
      await client.query(`ALTER EXTENSION "${row.name}" UPDATE`);
    }
  } finally {
    await client.end().catch(() => {
      /* ignore cleanup errors */
    });
  }

  // Recreate the pool so new connections pick up the updated extension.
  // Prepared statements are rebuilt by initPreparedStatements() later in the
  // startup sequence (after migrations), so no need to do it here.
  // If updateTimescaleExtensions() is ever called outside of initializeServices(),
  // you will need to call initPreparedStatements() immediately after.
  await recreatePool();
}

/**
 * Initialize TimescaleDB for the sessions table
 *
 * This function is idempotent and safe to run on:
 * - Fresh installs (sets everything up)
 * - Existing installs with TimescaleDB already configured (no-op)
 * - Partially configured installs (completes setup)
 * - Installs without TimescaleDB extension (graceful skip)
 */
export async function initTimescaleDB(): Promise<{
  success: boolean;
  status: TimescaleStatus;
  actions: string[];
  /**
   * Set when a historical aggregate backfill still needs to run. The caller
   * (index.ts) should invoke runAggregateBackfill(targetVersion) in the
   * background after the server starts listening.
   */
  backfillPending?: AggregateBackfillMarker;
}> {
  const actions: string[] = [];

  // Check if TimescaleDB extension is available
  const hasExtension = await isTimescaleInstalled();
  if (!hasExtension) {
    return {
      success: true, // Not a failure - just no TimescaleDB
      status: {
        extensionInstalled: false,
        sessionsIsHypertable: false,
        compressionEnabled: false,
        continuousAggregates: [],
        chunkCount: 0,
      },
      actions: ['TimescaleDB extension not installed - skipping setup'],
    };
  }

  actions.push('TimescaleDB extension found');

  // Ensure Community Edition (timescaledb.license = 'timescale') is active.
  // Compression, continuous aggregates, and retention policies all require it.
  // The Timescale License is free for self-hosted use — the only restriction is
  // offering TimescaleDB itself as a managed database service.
  // TimescaleDB's check hook only accepts PGC_S_FILE and PGC_S_ARGV sources,
  // so ALTER SYSTEM + reload is the only programmatic way to set this.
  try {
    const licenseResult = await db.execute(sql`SHOW timescaledb.license`);
    const license = (licenseResult.rows[0] as { timescaledb_license?: string } | undefined)
      ?.timescaledb_license;
    if (license === 'apache') {
      console.warn(
        '[TimescaleDB] Apache license detected — switching to Community Edition (free for self-hosted use)'
      );
      await db.execute(sql`ALTER SYSTEM SET timescaledb.license = 'timescale'`);
      await db.execute(sql`SELECT pg_reload_conf()`);
      actions.push('Switched to Community Edition license');
    }
  } catch (err) {
    console.warn(
      '[TimescaleDB] Could not verify or set license. If you see compression errors, ' +
        "add timescaledb.license = 'timescale' to your PostgreSQL configuration. " +
        'See: https://docs.timescale.com/about/latest/timescaledb-editions/',
      err
    );
  }

  // Enable Toolkit if available - not using any hyperfunctions yet but might later
  const toolkitAvailable = await isToolkitAvailableOnSystem();
  if (toolkitAvailable) {
    const toolkitInstalled = await isToolkitInstalled();
    if (!toolkitInstalled) {
      await db.execute(sql`CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit`);
      actions.push('TimescaleDB Toolkit extension enabled');
    } else {
      actions.push('TimescaleDB Toolkit extension already enabled');
    }
  } else {
    actions.push('TimescaleDB Toolkit not available (optional - using standard aggregates)');
  }

  // Check if sessions is already a hypertable
  const isHypertable = await isSessionsHypertable();
  if (!isHypertable) {
    await convertToHypertable();
    actions.push('Converted sessions table to hypertable');
  } else {
    actions.push('Sessions already a hypertable');
  }

  // Widen the chunk interval for existing hypertables. Idempotent and applies
  // only to chunks created after this point; existing chunks keep their size.
  try {
    await db.execute(sql`SELECT set_chunk_time_interval('sessions', INTERVAL '30 days')`);
    actions.push('Set sessions chunk_time_interval to 30 days');
  } catch (err) {
    console.warn('[TimescaleDB] Failed to set sessions chunk_time_interval:', err);
    actions.push('Chunk interval: could not set (non-fatal)');
  }

  // Check and create continuous aggregates
  // getContinuousAggregates() only covers the sessions hypertable; library_stats_daily
  // and content_quality_daily live on library_snapshots, so include both here or they'd
  // always show as "missing" below regardless of whether they actually exist.
  const existingAggregates = [
    ...(await getContinuousAggregates()),
    ...(await getLibrarySnapshotAggregates()),
  ];

  // IMPORTANT: Only include aggregates that are actively used
  // Old aggregates that are no longer needed are handled separately below
  const expectedAggregates = [
    'daily_content_engagement', // Engagement tracking system
    'user_media_plays_daily', // Identity-aware plays aggregate
    'daily_bandwidth_by_user', // Bandwidth analytics
    'library_stats_daily', // Library statistics aggregate
    'content_quality_daily', // Quality/codec evolution tracking
  ];

  // Remove deprecated aggregates if they still exist (cleanup from v1.4.x)
  // These caused FD exhaustion and lock contention with large histories
  const deprecatedAggregates = [
    'daily_plays_by_user',
    'daily_plays_by_server',
    'daily_stats_summary',
    'hourly_concurrent_streams',
  ];

  for (const deprecated of deprecatedAggregates) {
    if (existingAggregates.includes(deprecated)) {
      try {
        // Remove refresh policy first (prevents "policy not found" errors)
        await db.execute(
          sql.raw(`SELECT remove_continuous_aggregate_policy('${deprecated}', if_exists => true)`)
        );
        // Drop the aggregate itself
        await db.execute(sql.raw(`DROP MATERIALIZED VIEW IF EXISTS ${deprecated} CASCADE`));
        actions.push(`Removed deprecated aggregate: ${deprecated}`);
      } catch (dropErr) {
        console.warn(`[TimescaleDB] Failed to drop deprecated aggregate ${deprecated}:`, dropErr);
      }
    }
  }

  const missingAggregates = expectedAggregates.filter((agg) => !existingAggregates.includes(agg));

  // Check if any "missing" aggregates exist as regular materialized views
  // (e.g., created by migrations for non-TimescaleDB compatibility)
  // If so, drop them so we can recreate as continuous aggregates
  for (const agg of missingAggregates) {
    const dropped = await dropRegularMaterializedViewIfExists(agg, existingAggregates);
    if (dropped) {
      actions.push(
        `Dropped regular materialized view ${agg} (will recreate as continuous aggregate)`
      );
    }
  }

  // Check schema version - auto-rebuild if definitions have changed
  const storedVersion = await getStoredSchemaVersion();
  // Rebuild if: version changed AND this isn't a fresh install (storedVersion > 0)
  // Note: We check storedVersion > 0 instead of existingAggregates.length > 0 because
  // aggregates might have been dropped but we still need to do a full rebuild to
  // recreate the dependent views (content_engagement_summary, etc.)
  const needsRebuild = storedVersion !== AGGREGATE_SCHEMA_VERSION && storedVersion > 0;

  let backfillPending: AggregateBackfillMarker | undefined;

  if (needsRebuild) {
    const leftoverMarker = await getBackfillMarker();
    const canResumeInsteadOfRebuild = shouldResumeBackfillInsteadOfRebuild(
      leftoverMarker,
      AGGREGATE_SCHEMA_VERSION,
      missingAggregates.length
    );

    if (canResumeInsteadOfRebuild && leftoverMarker) {
      // Definitions were already rebuilt for this version; don't throw that materialized work away with another DROP CASCADE.
      backfillPending = leftoverMarker;
      actions.push(
        `Schema version changed (${storedVersion} → ${AGGREGATE_SCHEMA_VERSION}) but definitions were already rebuilt for this version - resuming pending backfill instead of recreating`
      );
    } else {
      // Only the cheap DDL runs synchronously here (drop/recreate aggregate + view
      // definitions, re-add refresh policies) plus a bounded refresh of the recent
      // window - never the unbounded full-history rescan, which can take long enough
      // to exceed a deploy platform's startup probe budget on large installs. The
      // schema version is intentionally not stored until the background historical
      // backfill (safeFullRefreshAllAggregates, via runAggregateBackfill in index.ts)
      // actually completes, so a crash mid-backfill resumes on the next boot instead
      // of leaving aggregates permanently short of history. Until backfill finishes,
      // aggregate-backed stats show partial (recent) data only.
      actions.push(
        `Schema version changed (${storedVersion} → ${AGGREGATE_SCHEMA_VERSION}) - recreating aggregate definitions`
      );
      const ddlStart = Date.now();
      try {
        await rebuildAggregateDefinitions();
        // Bounded refresh (~7 day window) so recently-viewed dashboards aren't empty
        // while the background historical backfill runs. endTime is capped at the
        // start of today (UTC, matching the aggregates' own `time_bucket('1 day', ...)`
        // grouping) rather than "now" or "tomorrow": these aggregates use
        // materialized_only=false, so real-time aggregation keeps today live by
        // unioning raw sessions newer than the materialization watermark - but
        // refreshing today's bucket at all, even partially, advances that watermark
        // through it, hiding every session recorded afterward until the next
        // scheduled policy tick. Stopping at yesterday's close leaves today on the
        // real-time path and still materializes the rest of the window. The
        // library_snapshots aggregates bucket daily the same way and also use
        // materialized_only=false, so the same cap applies to them - otherwise
        // library_stats_daily/content_quality_daily stay empty until the
        // background backfill finishes even though the log below says recent
        // data is available.
        const startOfTodayUtc = floorToUtcDay(new Date());
        await refreshAggregates({ endTime: startOfTodayUtc });
        await refreshLibrarySnapshotAggregates({ endTime: startOfTodayUtc });
        const ddlMs = Date.now() - ddlStart;
        await setBackfillMarker(AGGREGATE_SCHEMA_VERSION);
        backfillPending = {
          targetVersion: AGGREGATE_SCHEMA_VERSION,
          startedAt: new Date().toISOString(),
        };
        actions.push(
          `Recreated aggregate definitions in ${ddlMs}ms with recent data available now; ` +
            'full historical backfill scheduled in the background after startup'
        );
      } catch (err) {
        console.error(
          '[TimescaleDB] Failed to recreate aggregate definitions on schema version change:',
          err
        );
        actions.push(
          `Warning: Failed to recreate aggregate definitions: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } else if (missingAggregates.length > 0) {
    await createContinuousAggregates();
    await setupRefreshPolicies();
    await setStoredSchemaVersion(AGGREGATE_SCHEMA_VERSION);
    actions.push(`Created continuous aggregates: ${missingAggregates.join(', ')}`);
  } else {
    // Ensure version is stored even if aggregates already exist
    if (storedVersion === 0) {
      await setStoredSchemaVersion(AGGREGATE_SCHEMA_VERSION);
    }
    actions.push('All continuous aggregates exist and up-to-date');

    // A previous boot may have completed the DDL rebuild above but crashed or
    // restarted before the background backfill finished - resume it instead
    // of silently leaving aggregates with only partial history forever.
    const existingMarker = await getBackfillMarker();
    if (existingMarker) {
      backfillPending = existingMarker;
      actions.push(
        `Found pending aggregate backfill from a previous startup (target v${existingMarker.targetVersion}) - resuming in background`
      );
    }
  }

  // Check and enable compression
  const hasCompression = await isCompressionEnabled();
  if (!hasCompression) {
    await enableCompression();
    actions.push('Enabled compression on sessions');
  } else {
    // Check if compression settings need to be fixed (orderby column limit issue)
    const orderbyCorrect = await isCompressionOrderbyCorrect();
    if (!orderbyCorrect) {
      await fixCompressionSettings();
      actions.push('Fixed compression settings (orderby column limit)');
    } else {
      actions.push('Compression already enabled with correct settings');
    }
  }

  // Create partial indexes for optimized filtered queries
  try {
    await createPartialIndexes();
    actions.push('Created partial indexes (geo, violations, open-session, transcode)');
  } catch (err) {
    console.warn('Failed to create some partial indexes:', err);
    actions.push('Partial indexes: some may already exist');
  }

  // Create content and device tracking indexes
  try {
    await createContentIndexes();
    actions.push('Created content and device tracking indexes');
  } catch (err) {
    console.warn('Failed to create some content indexes:', err);
    actions.push('Content indexes: some may already exist');
  }

  // Must run unconditionally: the ensureEngagementViews call below is skipped when views exist
  try {
    if (await continuousAggregateExists('user_media_plays_daily')) {
      await ensureUserMediaPlaysIndex();
      actions.push('Ensured user media plays index');
    }
  } catch (err) {
    console.warn('Failed to create user media plays index:', err);
    actions.push('User media plays index: may already exist');
  }

  // Ensure engagement views exist (fixes broken installs and fresh installs)
  // These views depend on daily_content_engagement continuous aggregate
  // Skip if all views already exist to avoid unnecessary DDL on every startup
  try {
    const aggregatesExist = await continuousAggregateExists('daily_content_engagement');
    if (aggregatesExist) {
      const viewsExist = await engagementViewsExist();
      if (!viewsExist) {
        await ensureEngagementViews();
        actions.push('Created missing engagement views');
      } else {
        actions.push('Engagement views already exist');
      }
    }
  } catch (err) {
    console.warn('Failed to create engagement views:', err);
    actions.push('Engagement views: creation skipped (may need manual rebuild)');
  }

  // Topology just changed (hypertable, chunk interval, aggregates, compression) -
  // drop any stale cached status so the returned value reflects this run.
  invalidateTimescaleStatusCache();
  const status = await getTimescaleStatus();

  return {
    success: true,
    status,
    actions,
    backfillPending,
  };
}

/** List of engagement views created by ensureEngagementViews() */
const ENGAGEMENT_VIEWS = [
  'content_engagement_summary',
  'media_plays_daily',
  'episode_continuity_stats',
  'daily_show_intensity',
  'show_engagement_summary',
  'top_content_by_plays',
  'top_shows_by_engagement',
  'user_engagement_profile',
];

/**
 * Check if all engagement views already exist
 */
async function engagementViewsExist(): Promise<boolean> {
  try {
    const viewNames = sql.join(
      ENGAGEMENT_VIEWS.map((v) => sql`${v}`),
      sql`, `
    );
    const result = await db.execute(sql`
      SELECT COUNT(*)::int as count FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name IN (${viewNames})
    `);
    return (result.rows[0] as { count: number })?.count === ENGAGEMENT_VIEWS.length;
  } catch {
    return false;
  }
}

/**
 * Ensure all engagement views exist
 *
 * Creates or replaces all dependent views that sit on top of continuous aggregates.
 * Uses CREATE OR REPLACE VIEW which is idempotent - safe to run every startup.
 *
 * This is called:
 * 1. After rebuildTimescaleViews() recreates aggregates
 * 2. At the end of initTimescaleDB() to fix broken installs and ensure fresh installs have views
 */
// media_id-leading composite for per-item watched probes; the cagg's default (media_id, day) can't serve it
async function ensureUserMediaPlaysIndex(): Promise<void> {
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_user_media_plays_media_user
    ON user_media_plays_daily (media_id, server_user_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_user_media_plays_show_user
    ON user_media_plays_daily (show_media_id, server_user_id)
    WHERE show_media_id IS NOT NULL
  `);
}

async function ensureEngagementViews(): Promise<void> {
  // Create content_engagement_summary view
  await db.execute(sql`
    CREATE OR REPLACE VIEW content_engagement_summary AS
    SELECT
      server_user_id,
      rating_key,
      MAX(media_title) AS media_title,
      MAX(show_title) AS show_title,
      MAX(media_type) AS media_type,
      MAX(content_duration_ms) AS content_duration_ms,
      MAX(thumb_path) AS thumb_path,
      MAX(server_id::text)::uuid AS server_id,
      MAX(media_id::text)::uuid AS media_id,
      MAX(show_media_id::text)::uuid AS show_media_id,
      MAX(season_number) AS season_number,
      MAX(episode_number) AS episode_number,
      MAX(year) AS year,
      SUM(watched_ms) AS cumulative_watched_ms,
      MAX(max_progress_ms) AS max_progress_ms,
      SUM(valid_session_count) AS valid_sessions,
      SUM(total_session_count) AS total_sessions,
      MIN(day) AS first_watched_at,
      MAX(day) AS last_watched_at,
      BOOL_OR(any_marked_watched) AS ever_marked_watched,
      CASE
        WHEN MAX(content_duration_ms) > 0 THEN
          ROUND(100.0 * GREATEST(COALESCE(MAX(max_progress_ms), 0), SUM(watched_ms)) / MAX(content_duration_ms), 1)
        ELSE 0
      END AS completion_pct,
      CASE
        WHEN MAX(content_duration_ms) > 0 THEN
          GREATEST(
            CASE WHEN COALESCE(MAX(max_progress_ms), 0) >= MAX(content_duration_ms) * 0.85 THEN 1
                 WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.85 THEN 1
                 ELSE 0 END,
            FLOOR(SUM(watched_ms)::float / MAX(content_duration_ms))
          )::int
        ELSE 0
      END AS plays,
      CASE
        WHEN MAX(content_duration_ms) > 0 THEN
          CASE
            WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 2.0 THEN 'rewatched'
            WHEN COALESCE(MAX(max_progress_ms), 0) >= MAX(content_duration_ms) * 0.85 THEN 'watched'
            WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.85 THEN 'watched'
            WHEN GREATEST(COALESCE(MAX(max_progress_ms), 0), SUM(watched_ms)) >= MAX(content_duration_ms) * 0.5 THEN 'engaged'
            WHEN GREATEST(COALESCE(MAX(max_progress_ms), 0), SUM(watched_ms)) >= MAX(content_duration_ms) * 0.2 THEN 'sampled'
            ELSE 'abandoned'
          END
        ELSE 'unknown'
      END AS engagement_tier
    FROM daily_content_engagement
    GROUP BY server_user_id, rating_key
  `);

  await ensureUserMediaPlaysIndex();

  // Per-media-day rollup of user_media_plays_daily with a distinct-user count
  await db.execute(sql`
    CREATE OR REPLACE VIEW media_plays_daily AS
    SELECT
      day,
      server_id,
      media_id,
      MAX(show_media_id::text)::uuid AS show_media_id,
      MAX(media_type) AS media_type,
      SUM(plays) AS plays,
      SUM(watched_ms) AS watched_ms,
      COUNT(DISTINCT server_user_id) AS unique_users
    FROM user_media_plays_daily
    GROUP BY day, server_id, media_id
  `);

  // Create episode_continuity_stats view (for consecutive episode detection)
  await db.execute(sql`
    CREATE OR REPLACE VIEW episode_continuity_stats AS
    WITH episode_timeline AS (
      SELECT
        server_user_id,
        grandparent_title AS show_title,
        rating_key,
        started_at,
        stopped_at,
        EXTRACT(EPOCH FROM (
          started_at - LAG(stopped_at) OVER (
            PARTITION BY server_user_id, grandparent_title
            ORDER BY started_at
          )
        )) / 60 AS gap_minutes
      FROM sessions
      WHERE media_type = 'episode'
        AND grandparent_title IS NOT NULL
        AND duration_ms >= 120000
        AND stopped_at IS NOT NULL
    )
    SELECT
      server_user_id,
      show_title,
      COUNT(*) AS total_episode_watches,
      COUNT(*) FILTER (WHERE gap_minutes IS NOT NULL AND gap_minutes <= 30) AS consecutive_episodes,
      ROUND(100.0 * COUNT(*) FILTER (WHERE gap_minutes IS NOT NULL AND gap_minutes <= 30)
            / NULLIF(COUNT(*) - 1, 0), 1) AS consecutive_pct,
      ROUND(AVG(gap_minutes) FILTER (WHERE gap_minutes IS NOT NULL AND gap_minutes <= 480), 1) AS avg_gap_minutes
    FROM episode_timeline
    GROUP BY server_user_id, show_title
    HAVING COUNT(*) >= 2
  `);

  // Create daily_show_intensity view
  await db.execute(sql`
    CREATE OR REPLACE VIEW daily_show_intensity AS
    SELECT
      server_user_id,
      show_title,
      day,
      COUNT(DISTINCT rating_key) AS episodes_watched_this_day
    FROM daily_content_engagement
    WHERE media_type = 'episode'
      AND show_title IS NOT NULL
      AND valid_session_count > 0
    GROUP BY server_user_id, show_title, day
  `);

  // Create show_engagement_summary view with intensity metrics
  await db.execute(sql`
    CREATE OR REPLACE VIEW show_engagement_summary AS
    WITH intensity_stats AS (
      SELECT
        server_user_id,
        show_title,
        COUNT(DISTINCT day) AS total_viewing_days,
        MAX(episodes_watched_this_day) AS max_episodes_in_one_day,
        ROUND(AVG(episodes_watched_this_day), 1) AS avg_episodes_per_viewing_day
      FROM daily_show_intensity
      GROUP BY server_user_id, show_title
    )
    SELECT
      ces.server_user_id,
      ces.show_title,
      MAX(ces.server_id::text)::uuid AS server_id,
      MAX(ces.thumb_path) AS thumb_path,
      MAX(ces.year) AS year,
      COUNT(DISTINCT ces.rating_key) AS unique_episodes_watched,
      COUNT(DISTINCT CONCAT(ces.season_number, '-', ces.episode_number)) AS unique_episode_numbers,
      SUM(ces.plays) AS total_episode_plays,
      SUM(ces.cumulative_watched_ms) AS total_watched_ms,
      ROUND(SUM(ces.cumulative_watched_ms) / 1000.0 / 60 / 60, 1) AS total_watch_hours,
      SUM(ces.valid_sessions) AS total_valid_sessions,
      SUM(ces.total_sessions) AS total_all_sessions,
      MIN(ces.first_watched_at) AS first_watched_at,
      MAX(ces.last_watched_at) AS last_watched_at,
      EXTRACT(DAYS FROM (MAX(ces.last_watched_at) - MIN(ces.first_watched_at)))::int AS viewing_span_days,
      COALESCE(ist.total_viewing_days, 1) AS total_viewing_days,
      COALESCE(ist.max_episodes_in_one_day, 1) AS max_episodes_in_one_day,
      COALESCE(ist.avg_episodes_per_viewing_day, 1.0) AS avg_episodes_per_viewing_day,
      COUNT(*) FILTER (WHERE ces.engagement_tier IN ('watched', 'rewatched')) AS completed_episodes,
      COUNT(*) FILTER (WHERE ces.engagement_tier = 'abandoned') AS abandoned_episodes,
      ROUND(100.0 * COUNT(*) FILTER (WHERE ces.engagement_tier IN ('watched', 'rewatched'))
            / NULLIF(COUNT(*), 0), 1) AS episode_completion_rate
    FROM content_engagement_summary ces
    LEFT JOIN intensity_stats ist ON ces.server_user_id = ist.server_user_id AND ces.show_title = ist.show_title
    WHERE ces.media_type = 'episode' AND ces.show_title IS NOT NULL
    GROUP BY ces.server_user_id, ces.show_title, ist.total_viewing_days, ist.max_episodes_in_one_day, ist.avg_episodes_per_viewing_day
  `);

  // Create top_content_by_plays view
  await db.execute(sql`
    CREATE OR REPLACE VIEW top_content_by_plays AS
    SELECT
      rating_key,
      media_title,
      show_title,
      media_type,
      content_duration_ms,
      thumb_path,
      server_id,
      year,
      SUM(plays) AS total_plays,
      SUM(cumulative_watched_ms) AS total_watched_ms,
      ROUND(SUM(cumulative_watched_ms) / 1000.0 / 60 / 60, 1) AS total_watch_hours,
      COUNT(DISTINCT server_user_id) AS unique_viewers,
      SUM(valid_sessions) AS total_valid_sessions,
      SUM(total_sessions) AS total_all_sessions,
      COUNT(*) FILTER (WHERE engagement_tier IN ('watched', 'rewatched')) AS completions,
      COUNT(*) FILTER (WHERE engagement_tier = 'rewatched') AS rewatches,
      COUNT(*) FILTER (WHERE engagement_tier = 'abandoned') AS abandonments,
      COUNT(*) FILTER (WHERE engagement_tier = 'sampled') AS samples,
      ROUND(100.0 * COUNT(*) FILTER (WHERE engagement_tier IN ('watched', 'rewatched'))
            / NULLIF(COUNT(*), 0), 1) AS completion_rate,
      ROUND(100.0 * COUNT(*) FILTER (WHERE engagement_tier = 'abandoned')
            / NULLIF(COUNT(*), 0), 1) AS abandonment_rate
    FROM content_engagement_summary
    GROUP BY rating_key, media_title, show_title, media_type, content_duration_ms, thumb_path, server_id, year
  `);

  // Create top_shows_by_engagement with enhanced binge score
  await db.execute(sql`
    CREATE OR REPLACE VIEW top_shows_by_engagement AS
    SELECT
      ses.show_title,
      MAX(ses.server_id::text)::uuid AS server_id,
      MAX(ses.thumb_path) AS thumb_path,
      MAX(ses.year) AS year,
      SUM(ses.unique_episodes_watched) AS total_episode_views,
      SUM(ses.total_watch_hours) AS total_watch_hours,
      -- Count distinct people, not distinct accounts: a merged identity watching
      -- from two server accounts is one viewer.
      COUNT(DISTINCT su.user_id) AS unique_viewers,
      SUM(ses.total_valid_sessions) AS total_valid_sessions,
      SUM(ses.total_all_sessions) AS total_all_sessions,
      ROUND(AVG(ses.unique_episodes_watched), 1) AS avg_episodes_per_viewer,
      ROUND(AVG(ses.episode_completion_rate), 1) AS avg_completion_rate,
      ROUND(AVG(ses.avg_episodes_per_viewing_day), 1) AS avg_daily_intensity,
      ROUND(AVG(ses.max_episodes_in_one_day), 1) AS avg_max_daily_episodes,
      ROUND(AVG(COALESCE(ecs.consecutive_pct, 0)), 1) AS avg_consecutive_pct,
      ROUND(AVG(
        CASE
          WHEN ses.viewing_span_days > 0 THEN ses.unique_episodes_watched / (ses.viewing_span_days / 7.0)
          ELSE ses.unique_episodes_watched * 7
        END
      ), 1) AS avg_velocity,
      -- Enhanced Binge Score (0-100 scale):
      -- 40% Volume×Quality + 30% Daily Intensity + 20% Continuity + 10% Velocity
      ROUND(
        (
          LEAST(AVG(ses.unique_episodes_watched) * AVG(ses.episode_completion_rate) / 100, 40) * 1.0
          + LEAST(AVG(ses.avg_episodes_per_viewing_day) * 6, 30)
          + AVG(COALESCE(ecs.consecutive_pct, 0)) * 0.2
          + LEAST(AVG(
              CASE
                WHEN ses.viewing_span_days > 0 THEN ses.unique_episodes_watched / (ses.viewing_span_days / 7.0)
                ELSE ses.unique_episodes_watched * 7
              END
            ), 20) * 0.5
        ),
      1) AS binge_score
    FROM show_engagement_summary ses
    JOIN server_users su ON su.id = ses.server_user_id
    LEFT JOIN episode_continuity_stats ecs
      ON ses.server_user_id = ecs.server_user_id AND ses.show_title = ecs.show_title
    GROUP BY ses.show_title
  `);

  // Create user_engagement_profile view
  await db.execute(sql`
    CREATE OR REPLACE VIEW user_engagement_profile AS
    SELECT
      server_user_id,
      COUNT(DISTINCT rating_key) AS content_started,
      SUM(plays) AS total_plays,
      SUM(cumulative_watched_ms)::bigint AS total_watched_ms,
      ROUND(SUM(cumulative_watched_ms) / 1000.0 / 60 / 60, 1) AS total_watch_hours,
      SUM(valid_sessions) AS valid_session_count,
      SUM(total_sessions) AS total_session_count,
      COUNT(*) FILTER (WHERE engagement_tier = 'abandoned') AS abandoned_count,
      COUNT(*) FILTER (WHERE engagement_tier = 'sampled') AS sampled_count,
      COUNT(*) FILTER (WHERE engagement_tier = 'engaged') AS engaged_count,
      COUNT(*) FILTER (WHERE engagement_tier = 'watched') AS watched_count,
      COUNT(*) FILTER (WHERE engagement_tier = 'rewatched') AS rewatched_count,
      ROUND(100.0 * COUNT(*) FILTER (WHERE engagement_tier IN ('watched', 'rewatched'))
            / NULLIF(COUNT(*), 0), 1) AS completion_rate,
      CASE
        WHEN COUNT(*) = 0 THEN 'inactive'
        WHEN COUNT(*) FILTER (WHERE engagement_tier = 'rewatched') > COUNT(*) * 0.2 THEN 'rewatcher'
        WHEN COUNT(*) FILTER (WHERE engagement_tier IN ('watched', 'rewatched')) > COUNT(*) * 0.7 THEN 'completionist'
        WHEN COUNT(*) FILTER (WHERE engagement_tier = 'abandoned') > COUNT(*) * 0.5 THEN 'sampler'
        ELSE 'casual'
      END AS behavior_type,
      MODE() WITHIN GROUP (ORDER BY media_type) AS favorite_media_type
    FROM content_engagement_summary
    GROUP BY server_user_id
  `);
}

/**
 * Drop and recreate all continuous aggregate definitions plus dependent
 * engagement views (steps 1-4 of a full rebuild). This is DDL-only - no
 * historical data is refreshed - so it completes in seconds even on large
 * installs. Shared by rebuildTimescaleViews() and the startup version-mismatch
 * path in initTimescaleDB(), which schedules the (potentially slow) historical
 * refresh separately via runAggregateBackfill() after the server is listening.
 */
async function rebuildAggregateDefinitions(
  report?: (step: number, message: string) => void
): Promise<void> {
  const definitions = getAggregateDefinitions();

  // Step 1: Drop ALL existing continuous aggregates (CASCADE will drop dependent views)
  report?.(1, 'Dropping all existing continuous aggregates...');
  for (const def of definitions) {
    await db.execute(sql.raw(`DROP MATERIALIZED VIEW IF EXISTS ${def.name} CASCADE`));
  }

  // Step 2: Recreate all continuous aggregates with current definitions
  report?.(2, 'Creating continuous aggregates with updated definitions...');
  for (const def of definitions) {
    await createAggregate(def);
  }

  // Step 3: Add refresh policies for all aggregates
  report?.(3, 'Setting up refresh policies...');
  for (const def of definitions) {
    await addRefreshPolicy(def);
  }

  // Step 4: Create all engagement views
  report?.(4, 'Creating engagement views...');
  await ensureEngagementViews();
}

/** Options for rebuildTimescaleViews */
export interface RebuildTimescaleViewsOptions {
  /** If true, refresh all historical data after rebuild (can take minutes/hours) */
  fullRefresh?: boolean;
  /** Optional callback for progress updates */
  progressCallback?: (step: number, total: number, message: string) => void;
}

/**
 * Rebuild TimescaleDB views and continuous aggregates
 *
 * Drops and recreates all continuous aggregates.
 * Called automatically when schema version changes, or manually to recover from broken views.
 *
 * @param options - Rebuild options including fullRefresh and progressCallback
 */
export async function rebuildTimescaleViews(
  options?: RebuildTimescaleViewsOptions | ((step: number, total: number, message: string) => void)
): Promise<{ success: boolean; message: string }> {
  // Handle legacy signature (just progressCallback) for backwards compatibility
  const opts: RebuildTimescaleViewsOptions =
    typeof options === 'function' ? { progressCallback: options } : (options ?? {});
  const { fullRefresh = false, progressCallback } = opts;
  const hasExtension = await isTimescaleInstalled();
  if (!hasExtension) {
    return {
      success: false,
      message: 'TimescaleDB extension not installed',
    };
  }

  const totalSteps = fullRefresh ? 6 : 5;
  const report = (step: number, msg: string) => {
    progressCallback?.(step, totalSteps, msg);
  };

  try {
    await rebuildAggregateDefinitions(report);

    // Step 5: Optionally refresh historical data
    if (fullRefresh) {
      report(5, 'Refreshing historical data (this may take a while)...');
      await refreshAggregates({ fullRefresh: true });
      report(6, 'Historical data refresh complete');
    } else {
      report(5, 'Skipping historical refresh - policies will catch up automatically');
    }

    invalidateTimescaleStatusCache();

    return {
      success: true,
      message: fullRefresh
        ? 'Successfully rebuilt all TimescaleDB views with full data refresh'
        : 'Successfully rebuilt all TimescaleDB views',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TimescaleDB] Failed to rebuild views:', error);
    return {
      success: false,
      message: `Failed to rebuild views: ${message}`,
    };
  }
}

// ============================================================================
// Library Snapshots Hypertable
// ============================================================================

/**
 * Check if library_snapshots table is already a hypertable
 */
async function isLibrarySnapshotsHypertable(): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT EXISTS(
        SELECT 1 FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'library_snapshots'
      ) as is_hypertable
    `);
    return (result.rows[0] as { is_hypertable: boolean })?.is_hypertable ?? false;
  } catch {
    return false;
  }
}

/**
 * Convert library_snapshots table to a TimescaleDB hypertable
 *
 * Uses 1-day chunk intervals to match daily snapshot cadence.
 * Primary key modified to composite (id, snapshot_time) for hypertable requirements.
 */
async function convertLibrarySnapshotsToHypertable(): Promise<void> {
  // Check if snapshot_time already in primary key
  const pkResult = await db.execute(sql`
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE table_name = 'library_snapshots'
    AND constraint_type = 'PRIMARY KEY'
  `);

  const pkName = (pkResult.rows[0] as { constraint_name: string })?.constraint_name;

  if (pkName) {
    const pkColsResult = await db.execute(sql`
      SELECT column_name
      FROM information_schema.key_column_usage
      WHERE table_name = 'library_snapshots'
      AND constraint_name = ${pkName}
    `);

    const pkColumns = (pkColsResult.rows as { column_name: string }[]).map((r) => r.column_name);

    if (!pkColumns.includes('snapshot_time')) {
      // Drop existing primary key
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pkName)) {
        await db.execute(
          sql`ALTER TABLE "library_snapshots" DROP CONSTRAINT IF EXISTS ${sql.identifier(pkName)}`
        );
      }

      // Add composite primary key including time dimension
      await db.execute(sql`
        ALTER TABLE "library_snapshots" ADD PRIMARY KEY ("id", "snapshot_time")
      `);
    }
  }

  // Convert to hypertable with 1-day chunks (matches daily snapshot cadence)
  await db.execute(sql`
    SELECT create_hypertable('library_snapshots', 'snapshot_time',
      chunk_time_interval => INTERVAL '1 day',
      migrate_data => true,
      if_not_exists => true
    )
  `);
}

/**
 * Enable compression on library_snapshots hypertable
 *
 * Compression activates after 3 days to allow enrichment jobs to complete.
 * Segmentby uses server_id and library_id (low cardinality) to prevent explosion.
 */
async function enableLibrarySnapshotsCompression(): Promise<void> {
  // Enable compression settings with segmentby for efficient queries
  await db.execute(sql`
    ALTER TABLE library_snapshots SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'server_id, library_id'
    )
  `);

  // Compress chunks older than 3 days (allows enrichment to complete)
  await db.execute(sql`
    SELECT add_compression_policy('library_snapshots', INTERVAL '3 days', if_not_exists => true)
  `);
}

/**
 * Add retention policy to library_snapshots hypertable
 *
 * Drops chunks older than 90 days automatically. Aggregates (library_stats_daily)
 * preserve summarized history indefinitely, so raw data only needs short retention.
 * Matches manual cleanup_old_chunks job retention period.
 */
async function addLibrarySnapshotsRetention(): Promise<void> {
  // Remove any existing policy first to ensure we update to 90 days
  // (add_retention_policy with if_not_exists won't change existing policies)
  try {
    await db.execute(sql`SELECT remove_retention_policy('library_snapshots', if_exists => true)`);
  } catch {
    // Ignore errors - policy may not exist
  }
  await db.execute(sql`
    SELECT add_retention_policy('library_snapshots', INTERVAL '90 days', if_not_exists => true)
  `);
}

/**
 * Check if compression is enabled on library_snapshots
 */
async function isLibrarySnapshotsCompressionEnabled(): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT compression_enabled
      FROM timescaledb_information.hypertables
      WHERE hypertable_name = 'library_snapshots'
    `);
    return (result.rows[0] as { compression_enabled: boolean })?.compression_enabled ?? false;
  } catch {
    return false;
  }
}

/**
 * Initialize library_snapshots as a TimescaleDB hypertable
 *
 * This function is idempotent and safe to run multiple times:
 * - Converts table to hypertable with 1-day chunks
 * - Enables compression after 3-day window (allows enrichment to complete)
 * - Adds 90-day retention policy
 *
 * Called from initTimescaleDB() on server startup.
 */
export async function initLibrarySnapshotsHypertable(): Promise<{
  success: boolean;
  actions: string[];
}> {
  const actions: string[] = [];

  // Check if TimescaleDB extension is available
  const hasExtension = await isTimescaleInstalled();
  if (!hasExtension) {
    return {
      success: true, // Not a failure - just no TimescaleDB
      actions: ['TimescaleDB extension not installed - skipping library_snapshots setup'],
    };
  }

  // Check if table exists (might not if migration hasn't run)
  const tableExists = await db.execute(sql`
    SELECT EXISTS(
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'library_snapshots'
    ) as exists
  `);

  if (!(tableExists.rows[0] as { exists: boolean })?.exists) {
    return {
      success: true,
      actions: ['library_snapshots table does not exist yet - skipping hypertable setup'],
    };
  }

  // Convert to hypertable if not already
  const isHypertable = await isLibrarySnapshotsHypertable();
  if (!isHypertable) {
    await convertLibrarySnapshotsToHypertable();
    actions.push('Converted library_snapshots to hypertable with 1-day chunks');
  } else {
    actions.push('library_snapshots already a hypertable');
  }

  // Enable compression (idempotent)
  const hasCompression = await isLibrarySnapshotsCompressionEnabled();
  if (!hasCompression) {
    await enableLibrarySnapshotsCompression();
    actions.push('Enabled compression on library_snapshots (3-day window)');
  } else {
    actions.push('Compression already enabled on library_snapshots');
  }

  // Add retention policy (idempotent via if_not_exists)
  await addLibrarySnapshotsRetention();
  actions.push('Ensured 90-day retention policy on library_snapshots');

  // Check and create library continuous aggregates
  const existingLibraryAggregates = await getLibrarySnapshotAggregates();
  const expectedLibraryAggregates = ['library_stats_daily', 'content_quality_daily'];
  const missingLibraryAggregates = expectedLibraryAggregates.filter(
    (agg) => !existingLibraryAggregates.includes(agg)
  );

  if (missingLibraryAggregates.length > 0) {
    await createLibraryAggregates();
    // Setup refresh policies for library aggregates
    const definitions = getAggregateDefinitions();
    for (const def of definitions.filter(
      (d) => d.name === 'library_stats_daily' || d.name === 'content_quality_daily'
    )) {
      await addRefreshPolicy(def);
    }
    actions.push(`Created library aggregates: ${missingLibraryAggregates.join(', ')}`);
  } else {
    actions.push('All library continuous aggregates exist');
  }

  // Verify aggregates were created by querying system catalog
  const verifiedAggregates = await getLibrarySnapshotAggregates();
  if (verifiedAggregates.length > 0) {
    console.log(`[TimescaleDB] Library aggregates verified: ${verifiedAggregates.join(', ')}`);
  } else {
    console.warn(
      '[TimescaleDB] Warning: No library aggregates found in timescaledb_information.continuous_aggregates'
    );
  }

  return { success: true, actions };
}
