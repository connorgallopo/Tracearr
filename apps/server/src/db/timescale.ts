/**
 * TimescaleDB initialization and setup
 *
 * This module ensures TimescaleDB features are properly configured for the sessions table.
 * It runs on every server startup and is idempotent - safe to run multiple times.
 */

import { db } from './client.js';
import { sql } from 'drizzle-orm';
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
 */
const AGGREGATE_SCHEMA_VERSION = 4;

/** Config for a continuous aggregate view */
interface AggregateDefinition {
  name: string;
  toolkitSql: string;
  fallbackSql: string;
  refreshPolicy: {
    startOffset: string;
    endOffset: string;
    scheduleInterval: string;
  };
}

/** All continuous aggregate definitions with media type filtering */
function getAggregateDefinitions(): AggregateDefinition[] {
  const mediaFilter = PRIMARY_MEDIA_TYPES_SQL_LITERAL;

  return [
    {
      name: 'daily_plays_by_user',
      toolkitSql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS daily_plays_by_user
        WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
        SELECT
          time_bucket('1 day', started_at) AS day,
          server_user_id,
          hyperloglog(32768, COALESCE(reference_id, id)) AS plays_hll,
          SUM(COALESCE(duration_ms, 0)) AS total_duration_ms
        FROM sessions
        WHERE ${mediaFilter}
        GROUP BY day, server_user_id
        WITH NO DATA
      `,
      fallbackSql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS daily_plays_by_user
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 day', started_at) AS day,
          server_user_id,
          COUNT(*) AS play_count,
          SUM(COALESCE(duration_ms, 0)) AS total_duration_ms
        FROM sessions
        WHERE ${mediaFilter}
        GROUP BY day, server_user_id
        WITH NO DATA
      `,
      refreshPolicy: {
        startOffset: '3 days',
        endOffset: '1 hour',
        scheduleInterval: '5 minutes',
      },
    },
    {
      name: 'daily_plays_by_server',
      toolkitSql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS daily_plays_by_server
        WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
        SELECT
          time_bucket('1 day', started_at) AS day,
          server_id,
          hyperloglog(32768, COALESCE(reference_id, id)) AS plays_hll,
          SUM(COALESCE(duration_ms, 0)) AS total_duration_ms
        FROM sessions
        WHERE ${mediaFilter}
        GROUP BY day, server_id
        WITH NO DATA
      `,
      fallbackSql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS daily_plays_by_server
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 day', started_at) AS day,
          server_id,
          COUNT(*) AS play_count,
          SUM(COALESCE(duration_ms, 0)) AS total_duration_ms
        FROM sessions
        WHERE ${mediaFilter}
        GROUP BY day, server_id
        WITH NO DATA
      `,
      refreshPolicy: {
        startOffset: '3 days',
        endOffset: '1 hour',
        scheduleInterval: '5 minutes',
      },
    },
    {
      name: 'daily_stats_summary',
      toolkitSql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS daily_stats_summary
        WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
        SELECT
          time_bucket('1 day', started_at) AS day,
          hyperloglog(32768, COALESCE(reference_id, id)) AS plays_hll,
          hyperloglog(32768, server_user_id) AS users_hll,
          hyperloglog(32768, server_id) AS servers_hll,
          SUM(COALESCE(duration_ms, 0)) AS total_duration_ms,
          AVG(COALESCE(duration_ms, 0))::bigint AS avg_duration_ms
        FROM sessions
        WHERE ${mediaFilter}
        GROUP BY day
        WITH NO DATA
      `,
      fallbackSql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS daily_stats_summary
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 day', started_at) AS day,
          COUNT(DISTINCT COALESCE(reference_id, id)) AS play_count,
          COUNT(DISTINCT server_user_id) AS user_count,
          COUNT(DISTINCT server_id) AS server_count,
          SUM(COALESCE(duration_ms, 0)) AS total_duration_ms,
          AVG(COALESCE(duration_ms, 0))::bigint AS avg_duration_ms
        FROM sessions
        WHERE ${mediaFilter}
        GROUP BY day
        WITH NO DATA
      `,
      refreshPolicy: {
        startOffset: '3 days',
        endOffset: '1 hour',
        scheduleInterval: '5 minutes',
      },
    },
    {
      name: 'hourly_concurrent_streams',
      toolkitSql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_concurrent_streams
        WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
        SELECT
          time_bucket('1 hour', started_at) AS hour,
          server_id,
          COUNT(*) AS stream_count
        FROM sessions
        WHERE state IN ('playing', 'paused')
          AND ${mediaFilter}
        GROUP BY hour, server_id
        WITH NO DATA
      `,
      fallbackSql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_concurrent_streams
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 hour', started_at) AS hour,
          server_id,
          COUNT(*) AS stream_count
        FROM sessions
        WHERE state IN ('playing', 'paused')
          AND ${mediaFilter}
        GROUP BY hour, server_id
        WITH NO DATA
      `,
      refreshPolicy: {
        startOffset: '1 day',
        endOffset: '1 hour',
        scheduleInterval: '5 minutes',
      },
    },
    {
      name: 'daily_content_engagement',
      toolkitSql: `
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
          MAX(season_number) AS season_number,
          MAX(episode_number) AS episode_number,
          MAX(year) AS year,
          SUM(CASE WHEN duration_ms >= 120000 THEN duration_ms ELSE 0 END) AS watched_ms,
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
      fallbackSql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS daily_content_engagement
        WITH (timescaledb.continuous) AS
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
          MAX(season_number) AS season_number,
          MAX(episode_number) AS episode_number,
          MAX(year) AS year,
          SUM(CASE WHEN duration_ms >= 120000 THEN duration_ms ELSE 0 END) AS watched_ms,
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
      name: 'daily_bandwidth_by_user',
      toolkitSql: `
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
      fallbackSql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS daily_bandwidth_by_user
        WITH (timescaledb.continuous) AS
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
      name: 'library_stats_daily',
      // Use MAX() not SUM() - multiple snapshots per day represent the same library state
      // If a library has 1000 items and 3 snapshots exist, SUM would incorrectly produce 3000
      toolkitSql: `
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
          MAX(count_4k) AS count_4k,
          MAX(count_1080p) AS count_1080p,
          MAX(count_720p) AS count_720p,
          MAX(count_sd) AS count_sd
        FROM library_snapshots
        GROUP BY day, server_id, library_id
        WITH NO DATA
      `,
      fallbackSql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS library_stats_daily
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 day', snapshot_time) AS day,
          server_id,
          library_id,
          MAX(item_count) AS total_items,
          MAX(total_size) AS total_size_bytes,
          MAX(movie_count) AS movie_count,
          MAX(episode_count) AS episode_count,
          MAX(show_count) AS show_count,
          MAX(count_4k) AS count_4k,
          MAX(count_1080p) AS count_1080p,
          MAX(count_720p) AS count_720p,
          MAX(count_sd) AS count_sd
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
      name: 'content_quality_daily',
      // Server-level quality and codec metrics for tracking quality evolution over time
      // Use MAX() not SUM() - multiple intra-day snapshots represent the same server state
      toolkitSql: `
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
          MAX(av1_count) AS av1_count
        FROM library_snapshots
        GROUP BY day, server_id
        WITH NO DATA
      `,
      fallbackSql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS content_quality_daily
        WITH (timescaledb.continuous) AS
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
          MAX(av1_count) AS av1_count
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
 * Create a single continuous aggregate from its definition
 */
async function createAggregate(def: AggregateDefinition, hasToolkit: boolean): Promise<void> {
  const sqlStatement = hasToolkit ? def.toolkitSql : def.fallbackSql;
  await db.execute(sql.raw(sqlStatement));
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

    // Drop FK constraint from violations if it exists
    await db.execute(sql`
      ALTER TABLE "violations" DROP CONSTRAINT IF EXISTS "violations_session_id_sessions_id_fk"
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

    // Add index for violations session lookup (since we can't have FK to hypertable)
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "violations_session_lookup_idx" ON "violations" ("session_id")
    `);
  }

  // Convert to hypertable
  await db.execute(sql`
    SELECT create_hypertable('sessions', 'started_at',
      chunk_time_interval => INTERVAL '7 days',
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

  // Partial index for unacknowledged violations by user (hot path for user-specific alerts)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_violations_unacked_partial
    ON violations (server_user_id, created_at DESC)
    WHERE acknowledged_at IS NULL
  `);

  // Partial index for unacknowledged violations list (hot path for main violations list)
  // This index is optimized for the common query: ORDER BY created_at DESC WHERE acknowledged_at IS NULL
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_violations_unacked_list
    ON violations (created_at DESC)
    WHERE acknowledged_at IS NULL
  `);

  // Partial index for active/playing sessions
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sessions_active_partial
    ON sessions (server_id, server_user_id, started_at DESC)
    WHERE state = 'playing'
  `);

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
  // Time-prefixed index for media title queries
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sessions_media_time
    ON sessions (started_at DESC, media_type, media_title)
  `);

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

  // Library aggregates don't use HyperLogLog, they use simple MAX() aggregation
  // Pass hasToolkit=true to use toolkitSql which is identical to fallbackSql for these
  for (const def of libraryAggregates) {
    await createAggregate(def, true);
  }
}

/**
 * Create continuous aggregates for dashboard performance
 *
 * Uses HyperLogLog from TimescaleDB Toolkit for approximate distinct counts
 * (99.5% accuracy) since TimescaleDB doesn't support COUNT(DISTINCT) in
 * continuous aggregates. Falls back to COUNT(*) if Toolkit unavailable.
 */
async function createContinuousAggregates(): Promise<void> {
  const hasToolkit = await isToolkitInstalled();
  const definitions = getAggregateDefinitions();

  // Drop old unused aggregates
  // daily_plays_by_platform: platform stats use prepared statement instead
  // daily_play_patterns/hourly_play_patterns: never wired up, missing server_id for multi-server filtering
  await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS daily_plays_by_platform CASCADE`);
  await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS daily_play_patterns CASCADE`);
  await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS hourly_play_patterns CASCADE`);

  if (!hasToolkit) {
    console.warn('TimescaleDB Toolkit not available - using COUNT(*) aggregates');
  }

  // Create all aggregates from shared definitions
  for (const def of definitions) {
    await createAggregate(def, hasToolkit);
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
  await db.execute(sql`
    ALTER TABLE sessions SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'server_user_id, server_id'
    )
  `);

  // Add compression policy (compress chunks older than 7 days)
  await db.execute(sql`
    SELECT add_compression_policy('sessions', INTERVAL '7 days', if_not_exists => true)
  `);
}

/**
 * Manually refresh all continuous aggregates
 * Call this after bulk data imports (e.g., Tautulli import) to make the data immediately available
 */
export async function refreshAggregates(): Promise<void> {
  const hasExtension = await isTimescaleInstalled();
  if (!hasExtension) return;

  const aggregates = await getContinuousAggregates();

  for (const aggregate of aggregates) {
    try {
      // Refresh the entire aggregate (no time bounds = full refresh)
      // Note: aggregate names come from pg_catalog query, safe to use in identifier position
      await db.execute(sql`CALL refresh_continuous_aggregate(${aggregate}::regclass, NULL, NULL)`);
    } catch (err) {
      // Log but don't fail - aggregate might not have data yet
      console.warn(`Failed to refresh aggregate ${aggregate}:`, err);
    }
  }
}

/**
 * Get current TimescaleDB status
 */
export async function getTimescaleStatus(): Promise<TimescaleStatus> {
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

  // Enable TimescaleDB Toolkit for HyperLogLog (approximate distinct counts)
  // Check if available first to avoid noisy PostgreSQL errors in logs
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

  // Check and create continuous aggregates
  const existingAggregates = await getContinuousAggregates();
  const expectedAggregates = [
    'daily_plays_by_user',
    'daily_plays_by_server',
    'daily_stats_summary',
    'hourly_concurrent_streams',
    'daily_content_engagement', // Engagement tracking system
    'daily_bandwidth_by_user', // Bandwidth analytics
    'library_stats_daily', // Library statistics aggregate
    'content_quality_daily', // Quality/codec evolution tracking
  ];

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

  if (needsRebuild) {
    actions.push(
      `Schema version changed (${storedVersion} → ${AGGREGATE_SCHEMA_VERSION}) - rebuilding all aggregates`
    );
    const rebuildResult = await rebuildTimescaleViews();
    if (rebuildResult.success) {
      await setStoredSchemaVersion(AGGREGATE_SCHEMA_VERSION);
      actions.push('Successfully rebuilt all aggregates with updated definitions');
    } else {
      actions.push(`Warning: Failed to rebuild aggregates: ${rebuildResult.message}`);
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
  }

  // Check and enable compression
  const hasCompression = await isCompressionEnabled();
  if (!hasCompression) {
    await enableCompression();
    actions.push('Enabled compression on sessions');
  } else {
    actions.push('Compression already enabled');
  }

  // Create partial indexes for optimized filtered queries
  try {
    await createPartialIndexes();
    actions.push('Created partial indexes (geo, violations, active, transcode)');
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

  // Initialize library_snapshots hypertable (for library statistics feature)
  try {
    const librarySnapshotsResult = await initLibrarySnapshotsHypertable();
    actions.push(...librarySnapshotsResult.actions);
  } catch (err) {
    console.warn('Failed to initialize library_snapshots hypertable:', err);
    actions.push('library_snapshots hypertable: initialization skipped (table may not exist yet)');
  }

  // Get final status
  const status = await getTimescaleStatus();

  return {
    success: true,
    status,
    actions,
  };
}

/**
 * Rebuild TimescaleDB views and continuous aggregates
 *
 * Drops and recreates all continuous aggregates.
 * Called automatically when schema version changes, or manually to recover from broken views.
 *
 * @param progressCallback - Optional callback for progress updates
 */
export async function rebuildTimescaleViews(
  progressCallback?: (step: number, total: number, message: string) => void
): Promise<{ success: boolean; message: string }> {
  const hasExtension = await isTimescaleInstalled();
  if (!hasExtension) {
    return {
      success: false,
      message: 'TimescaleDB extension not installed',
    };
  }

  const totalSteps = 10;
  const report = (step: number, msg: string) => {
    progressCallback?.(step, totalSteps, msg);
  };

  try {
    const definitions = getAggregateDefinitions();

    // Step 1: Drop ALL existing continuous aggregates (CASCADE will drop dependent views)
    report(1, 'Dropping all existing continuous aggregates...');
    for (const def of definitions) {
      await db.execute(sql.raw(`DROP MATERIALIZED VIEW IF EXISTS ${def.name} CASCADE`));
    }

    // Step 2: Check for toolkit
    report(2, 'Checking TimescaleDB Toolkit availability...');
    const hasToolkit = await isToolkitInstalled();

    // Step 3: Recreate all continuous aggregates with current definitions
    report(3, 'Creating continuous aggregates with updated definitions...');
    for (const def of definitions) {
      await createAggregate(def, hasToolkit);
    }

    // Step 4: Add refresh policies for all aggregates
    report(4, 'Setting up refresh policies...');
    for (const def of definitions) {
      await addRefreshPolicy(def);
    }

    // Step 5: Create content_engagement_summary view
    report(5, 'Creating content_engagement_summary view...');
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
        MAX(season_number) AS season_number,
        MAX(episode_number) AS episode_number,
        MAX(year) AS year,
        SUM(watched_ms) AS cumulative_watched_ms,
        SUM(valid_session_count) AS valid_sessions,
        SUM(total_session_count) AS total_sessions,
        MIN(day) AS first_watched_at,
        MAX(day) AS last_watched_at,
        BOOL_OR(any_marked_watched) AS ever_marked_watched,
        CASE
          WHEN MAX(content_duration_ms) > 0 THEN
            ROUND(100.0 * SUM(watched_ms) / MAX(content_duration_ms), 1)
          ELSE 0
        END AS completion_pct,
        CASE
          WHEN MAX(content_duration_ms) > 0 THEN
            GREATEST(0, FLOOR(SUM(watched_ms)::float / MAX(content_duration_ms)))::int
          ELSE 0
        END AS plays,
        CASE
          WHEN MAX(content_duration_ms) > 0 THEN
            CASE
              WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 2.0 THEN 'rewatched'
              WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 1.0 THEN 'finished'
              WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.8 THEN 'completed'
              WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.5 THEN 'engaged'
              WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.2 THEN 'sampled'
              ELSE 'abandoned'
            END
          ELSE 'unknown'
        END AS engagement_tier
      FROM daily_content_engagement
      GROUP BY server_user_id, rating_key
    `);

    // Step 6: Create episode_continuity_stats view (for consecutive episode detection)
    report(6, 'Creating episode_continuity_stats view...');
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

    // Step 6b: Create daily_show_intensity view
    report(6, 'Creating daily_show_intensity view...');
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

    // Step 6c: Create show_engagement_summary view with intensity metrics
    report(6, 'Creating show_engagement_summary view...');
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
        COUNT(*) FILTER (WHERE ces.engagement_tier IN ('completed', 'finished', 'rewatched')) AS completed_episodes,
        COUNT(*) FILTER (WHERE ces.engagement_tier = 'abandoned') AS abandoned_episodes,
        ROUND(100.0 * COUNT(*) FILTER (WHERE ces.engagement_tier IN ('completed', 'finished', 'rewatched'))
              / NULLIF(COUNT(*), 0), 1) AS episode_completion_rate
      FROM content_engagement_summary ces
      LEFT JOIN intensity_stats ist ON ces.server_user_id = ist.server_user_id AND ces.show_title = ist.show_title
      WHERE ces.media_type = 'episode' AND ces.show_title IS NOT NULL
      GROUP BY ces.server_user_id, ces.show_title, ist.total_viewing_days, ist.max_episodes_in_one_day, ist.avg_episodes_per_viewing_day
    `);

    // Step 7: Create top_content_by_plays view
    report(7, 'Creating top_content_by_plays view...');
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
        COUNT(*) FILTER (WHERE engagement_tier IN ('completed', 'finished', 'rewatched')) AS completions,
        COUNT(*) FILTER (WHERE engagement_tier = 'rewatched') AS rewatches,
        COUNT(*) FILTER (WHERE engagement_tier = 'abandoned') AS abandonments,
        COUNT(*) FILTER (WHERE engagement_tier = 'sampled') AS samples,
        ROUND(100.0 * COUNT(*) FILTER (WHERE engagement_tier IN ('completed', 'finished', 'rewatched'))
              / NULLIF(COUNT(*), 0), 1) AS completion_rate,
        ROUND(100.0 * COUNT(*) FILTER (WHERE engagement_tier = 'abandoned')
              / NULLIF(COUNT(*), 0), 1) AS abandonment_rate
      FROM content_engagement_summary
      GROUP BY rating_key, media_title, show_title, media_type, content_duration_ms, thumb_path, server_id, year
    `);

    // Step 8: Create top_shows_by_engagement with enhanced binge score
    report(8, 'Creating top_shows_by_engagement view with enhanced binge score...');
    await db.execute(sql`
      CREATE OR REPLACE VIEW top_shows_by_engagement AS
      SELECT
        ses.show_title,
        MAX(ses.server_id::text)::uuid AS server_id,
        MAX(ses.thumb_path) AS thumb_path,
        MAX(ses.year) AS year,
        SUM(ses.unique_episodes_watched) AS total_episode_views,
        SUM(ses.total_watch_hours) AS total_watch_hours,
        COUNT(DISTINCT ses.server_user_id) AS unique_viewers,
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
      LEFT JOIN episode_continuity_stats ecs
        ON ses.server_user_id = ecs.server_user_id AND ses.show_title = ecs.show_title
      GROUP BY ses.show_title
    `);

    // Step 9: Create user_engagement_profile view
    report(9, 'Creating user_engagement_profile view...');
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
        COUNT(*) FILTER (WHERE engagement_tier IN ('completed', 'finished')) AS completed_count,
        COUNT(*) FILTER (WHERE engagement_tier = 'rewatched') AS rewatched_count,
        ROUND(100.0 * COUNT(*) FILTER (WHERE engagement_tier IN ('completed', 'finished', 'rewatched'))
              / NULLIF(COUNT(*), 0), 1) AS completion_rate,
        CASE
          WHEN COUNT(*) = 0 THEN 'inactive'
          WHEN COUNT(*) FILTER (WHERE engagement_tier = 'rewatched') > COUNT(*) * 0.2 THEN 'rewatcher'
          WHEN COUNT(*) FILTER (WHERE engagement_tier IN ('completed', 'finished', 'rewatched')) > COUNT(*) * 0.7 THEN 'completionist'
          WHEN COUNT(*) FILTER (WHERE engagement_tier = 'abandoned') > COUNT(*) * 0.5 THEN 'sampler'
          ELSE 'casual'
        END AS behavior_type,
        MODE() WITHIN GROUP (ORDER BY media_type) AS favorite_media_type
      FROM content_engagement_summary
      GROUP BY server_user_id
    `);

    // Step 10: Refresh ALL continuous aggregates with historical data
    report(10, 'Refreshing all continuous aggregates with historical data...');
    for (const def of definitions) {
      await db.execute(sql.raw(`CALL refresh_continuous_aggregate('${def.name}', NULL, NULL)`));
    }

    return {
      success: true,
      message: 'Successfully rebuilt all TimescaleDB views',
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
 * Drops chunks older than 1 year automatically.
 */
async function addLibrarySnapshotsRetention(): Promise<void> {
  await db.execute(sql`
    SELECT add_retention_policy('library_snapshots', INTERVAL '1 year', if_not_exists => true)
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
 * - Adds 1-year retention policy
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
  actions.push('Ensured 1-year retention policy on library_snapshots');

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
