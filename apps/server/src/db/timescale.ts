/**
 * TimescaleDB initialization and setup
 *
 * This module ensures TimescaleDB features are properly configured for the sessions table.
 * It runs on every server startup and is idempotent - safe to run multiple times.
 */

import { db } from './client.js';
import { sql } from 'drizzle-orm';

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
    if (pkName) {
      await db.execute(sql.raw(`ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "${pkName}"`));
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
 * Create continuous aggregates for dashboard performance
 *
 * Uses HyperLogLog from TimescaleDB Toolkit for approximate distinct counts
 * (99.5% accuracy) since TimescaleDB doesn't support COUNT(DISTINCT) in
 * continuous aggregates. Falls back to COUNT(*) if Toolkit unavailable.
 */
async function createContinuousAggregates(): Promise<void> {
  const hasToolkit = await isToolkitInstalled();

  // Drop old unused aggregates
  // daily_plays_by_platform: platform stats use prepared statement instead
  // daily_play_patterns/hourly_play_patterns: never wired up, missing server_id for multi-server filtering
  await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS daily_plays_by_platform CASCADE`);
  await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS daily_play_patterns CASCADE`);
  await db.execute(sql`DROP MATERIALIZED VIEW IF EXISTS hourly_play_patterns CASCADE`);

  if (hasToolkit) {
    // Use HyperLogLog for accurate distinct play counting
    // hyperloglog(32768, ...) gives ~0.4% error rate

    // Daily plays by user with HyperLogLog
    await db.execute(sql`
      CREATE MATERIALIZED VIEW IF NOT EXISTS daily_plays_by_user
      WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
      SELECT
        time_bucket('1 day', started_at) AS day,
        server_user_id,
        hyperloglog(32768, COALESCE(reference_id, id)) AS plays_hll,
        SUM(COALESCE(duration_ms, 0)) AS total_duration_ms
      FROM sessions
      GROUP BY day, server_user_id
      WITH NO DATA
    `);

    // Daily plays by server with HyperLogLog
    await db.execute(sql`
      CREATE MATERIALIZED VIEW IF NOT EXISTS daily_plays_by_server
      WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
      SELECT
        time_bucket('1 day', started_at) AS day,
        server_id,
        hyperloglog(32768, COALESCE(reference_id, id)) AS plays_hll,
        SUM(COALESCE(duration_ms, 0)) AS total_duration_ms
      FROM sessions
      GROUP BY day, server_id
      WITH NO DATA
    `);

    // Daily stats summary (main dashboard aggregate) with HyperLogLog
    await db.execute(sql`
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
      GROUP BY day
      WITH NO DATA
    `);

    // Hourly concurrent streams (used by /concurrent endpoint)
    // Note: This uses COUNT(*) since concurrent streams isn't about unique plays
    await db.execute(sql`
      CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_concurrent_streams
      WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
      SELECT
        time_bucket('1 hour', started_at) AS hour,
        server_id,
        COUNT(*) AS stream_count
      FROM sessions
      WHERE state IN ('playing', 'paused')
      GROUP BY hour, server_id
      WITH NO DATA
    `);
  } else {
    // Fallback: Standard aggregates without HyperLogLog
    // Note: These use COUNT(*) which overcounts resumed sessions
    console.warn('TimescaleDB Toolkit not available - using COUNT(*) aggregates');

    await db.execute(sql`
      CREATE MATERIALIZED VIEW IF NOT EXISTS daily_plays_by_user
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket('1 day', started_at) AS day,
        server_user_id,
        COUNT(*) AS play_count,
        SUM(COALESCE(duration_ms, 0)) AS total_duration_ms
      FROM sessions
      GROUP BY day, server_user_id
      WITH NO DATA
    `);

    await db.execute(sql`
      CREATE MATERIALIZED VIEW IF NOT EXISTS daily_plays_by_server
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket('1 day', started_at) AS day,
        server_id,
        COUNT(*) AS play_count,
        SUM(COALESCE(duration_ms, 0)) AS total_duration_ms
      FROM sessions
      GROUP BY day, server_id
      WITH NO DATA
    `);

    await db.execute(sql`
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
      GROUP BY day
      WITH NO DATA
    `);

    // Hourly concurrent streams (used by /concurrent endpoint)
    await db.execute(sql`
      CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_concurrent_streams
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket('1 hour', started_at) AS hour,
        server_id,
        COUNT(*) AS stream_count
      FROM sessions
      WHERE state IN ('playing', 'paused')
      GROUP BY hour, server_id
      WITH NO DATA
    `);
  }
}

/**
 * Set up refresh policies for continuous aggregates
 * Refreshes every 5 minutes with 1 hour lag for real-time dashboard
 */
async function setupRefreshPolicies(): Promise<void> {
  await db.execute(sql`
    SELECT add_continuous_aggregate_policy('daily_plays_by_user',
      start_offset => INTERVAL '3 days',
      end_offset => INTERVAL '1 hour',
      schedule_interval => INTERVAL '5 minutes',
      if_not_exists => true
    )
  `);

  await db.execute(sql`
    SELECT add_continuous_aggregate_policy('daily_plays_by_server',
      start_offset => INTERVAL '3 days',
      end_offset => INTERVAL '1 hour',
      schedule_interval => INTERVAL '5 minutes',
      if_not_exists => true
    )
  `);

  await db.execute(sql`
    SELECT add_continuous_aggregate_policy('daily_stats_summary',
      start_offset => INTERVAL '3 days',
      end_offset => INTERVAL '1 hour',
      schedule_interval => INTERVAL '5 minutes',
      if_not_exists => true
    )
  `);

  await db.execute(sql`
    SELECT add_continuous_aggregate_policy('hourly_concurrent_streams',
      start_offset => INTERVAL '1 day',
      end_offset => INTERVAL '1 hour',
      schedule_interval => INTERVAL '5 minutes',
      if_not_exists => true
    )
  `);
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
      await db.execute(sql.raw(`CALL refresh_continuous_aggregate('${aggregate}', NULL, NULL)`));
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
  ];

  const missingAggregates = expectedAggregates.filter((agg) => !existingAggregates.includes(agg));

  if (missingAggregates.length > 0) {
    await createContinuousAggregates();
    await setupRefreshPolicies();
    actions.push(`Created continuous aggregates: ${missingAggregates.join(', ')}`);
  } else {
    actions.push('All continuous aggregates exist');
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

  // Get final status
  const status = await getTimescaleStatus();

  return {
    success: true,
    status,
    actions,
  };
}
