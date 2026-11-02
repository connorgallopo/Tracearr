/**
 * Library Storage Analytics Route
 *
 * GET /storage - Storage usage, trends, linear regression predictions, and a
 * live per-library breakdown
 *
 * Uses library_items.file_size and created_at for accurate storage tracking
 * based on when items were actually added to the media server.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  TIME_MS,
  libraryStorageQuerySchema,
  type LibraryStorageQueryInput,
  type LibraryStorageResponse,
  type StorageHistoryPoint,
  type StorageLibraryRow,
  type StoragePrediction,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { getSetting } from '../../services/settings.js';
import {
  validateServerAccess,
  resolveServerIds,
  buildMultiServerFragment,
} from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey, dedupedStorageBytesSql, resolveLibraryWindow } from './utils.js';
import { serverCacheSegment } from '../../lib/scope.js';

// ============================================================================
// Linear Regression Implementation
// ============================================================================

interface DataPoint {
  x: number;
  y: number;
}

interface RegressionResult {
  slope: number;
  intercept: number;
  r2: number;
}

/**
 * Simple linear regression using least squares method.
 *
 * @param data - Array of (x, y) data points
 * @returns Slope, intercept, and R-squared coefficient
 */
function linearRegression(data: DataPoint[]): RegressionResult {
  const n = data.length;
  if (n < 2) return { slope: 0, intercept: data[0]?.y ?? 0, r2: 0 };

  const meanX = data.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = data.reduce((sum, p) => sum + p.y, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (const point of data) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }

  const slope = denominator !== 0 ? numerator / denominator : 0;
  const intercept = meanY - slope * meanX;

  // Calculate R-squared (coefficient of determination)
  const ssRes = data.reduce((sum, p) => sum + (p.y - (slope * p.x + intercept)) ** 2, 0);
  const ssTot = data.reduce((sum, p) => sum + (p.y - meanY) ** 2, 0);
  const r2 = ssTot !== 0 ? 1 - ssRes / ssTot : 0;

  return { slope, intercept, r2 };
}

// ============================================================================
// Growth Fit Selection
// ============================================================================

interface GrowthFitRow {
  day: string;
}

interface GrowthFitSelection<T extends GrowthFitRow> {
  fitRows: T[];
  basis: 'current' | 'preChangeover';
  /** Days of current-semantics data; what predictions and the countdown key on */
  postDaysSpanned: number;
}

/** Inclusive calendar-day span of a sorted daily series */
function daysSpanned(rows: GrowthFitRow[]): number {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return 0;
  return (
    Math.round((new Date(last.day).getTime() - new Date(first.day).getTime()) / TIME_MS.DAY) + 1
  );
}

/**
 * Pick the rows the growth regression fits. Storage totals changed meaning at
 * mediaVersionsBackfilledAt (multi-version rollups), so a fit must never span
 * the stamp: the one-time correction would read as growth. Prefer the
 * post-stamp side once it has minDays of data; until then the pre-stamp side
 * stands in for the growth rate, since its slope is internally consistent even
 * though its levels are old-semantics. Exported for tests.
 */
export function selectGrowthFit<T extends GrowthFitRow>(
  rows: T[],
  stampMs: number | null,
  minDays: number
): GrowthFitSelection<T> {
  if (stampMs === null || !rows.some((row) => new Date(row.day).getTime() < stampMs)) {
    return { fitRows: rows, basis: 'current', postDaysSpanned: daysSpanned(rows) };
  }
  const postRows = rows.filter((row) => new Date(row.day).getTime() >= stampMs);
  const postDaysSpanned = daysSpanned(postRows);
  if (postDaysSpanned >= minDays) {
    return { fitRows: postRows, basis: 'current', postDaysSpanned };
  }
  const preRows = rows.filter((row) => new Date(row.day).getTime() < stampMs);
  if (daysSpanned(preRows) >= minDays) {
    return { fitRows: preRows, basis: 'preChangeover', postDaysSpanned };
  }
  return { fitRows: postRows, basis: 'current', postDaysSpanned };
}

// ============================================================================
// Route Implementation
// ============================================================================

/**
 * Determine prediction confidence based on R-squared value.
 */
function getConfidenceLevel(r2: number): 'high' | 'medium' | 'low' {
  if (r2 >= 0.8) return 'high';
  if (r2 >= 0.5) return 'medium';
  return 'low';
}

/**
 * Calculate prediction with min/max bounds based on R-squared.
 * Higher R-squared = tighter bounds.
 */
function calculatePrediction(
  regression: RegressionResult,
  daysFromNow: number,
  currentDayNumber: number
): StoragePrediction {
  const futureX = currentDayNumber + daysFromNow;
  const predicted = regression.slope * futureX + regression.intercept;

  // Calculate margin of error based on R-squared
  // Lower R-squared = wider bounds
  const margin = Math.abs(predicted) * (1 - regression.r2) * 0.5;

  // Ensure predictions don't go negative
  const predictedValue = Math.max(0, predicted);
  const minValue = Math.max(0, predicted - margin);
  const maxValue = Math.max(0, predicted + margin);

  return {
    predicted: Math.round(predictedValue).toString(),
    min: Math.round(minValue).toString(),
    max: Math.round(maxValue).toString(),
  };
}

export const libraryStorageRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /storage - Storage analytics with predictions
   *
   * Returns current storage usage, historical trend, growth rate,
   * and linear regression predictions for future storage needs.
   *
   * Calculates storage from library_items.file_size and created_at
   * for accurate tracking based on when items were added.
   */
  app.get<{ Querystring: LibraryStorageQueryInput }>(
    '/storage',
    { preHandler: [app.requirePermission('insights', 'read')] },
    async (request, reply) => {
      const query = libraryStorageQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, serverIds, libraryId, timezone } = query.data;
      const { startDate, lastDay, cacheSegment } = resolveLibraryWindow(query.data);
      const authUser = request.user;
      const tz = timezone ?? 'UTC';

      // Validate server access if specific server requested
      if (serverId) {
        const error = validateServerAccess(authUser, serverId);
        if (error) {
          return reply.forbidden(error);
        }
      }

      const resolvedIds = resolveServerIds(authUser, serverId, serverIds, { strict: false });

      // v2: the response carries libraries[]
      const cacheKey = buildLibraryCacheKey(
        `${REDIS_KEYS.LIBRARY_STORAGE}:v2`,
        serverCacheSegment(resolvedIds),
        cacheSegment,
        tz
      );
      const fullCacheKey = libraryId ? `${cacheKey}:${libraryId}` : cacheKey;

      // Try cache first
      const cached = await app.redis.get(fullCacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as LibraryStorageResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Build server filter for library_stats_daily
      const serverFilter = buildMultiServerFragment(resolvedIds, 'lsd.server_id');

      // Optional library filter
      const libraryFilter = libraryId ? sql`AND lsd.library_id = ${libraryId}` : sql``;

      // For 'all' period, find the earliest snapshot date from library_stats_daily
      let effectiveStartDate: Date;
      if (startDate) {
        effectiveStartDate = startDate;
      } else {
        // Query for the earliest snapshot date
        const earliestResult = await db.execute(sql`
          SELECT MIN(day)::date AS earliest
          FROM library_stats_daily lsd
          WHERE 1=1
            ${serverFilter}
            ${libraryFilter}
        `);
        const earliest = (earliestResult.rows[0] as { earliest: string | null })?.earliest;
        effectiveStartDate = earliest ? new Date(earliest) : new Date('2020-01-01');
      }

      // Query library_stats_daily continuous aggregate
      // This uses pre-computed daily snapshots that already contain cumulative totals
      const result = await db.execute(sql`
        WITH date_series AS (
          -- Generate all dates in the range
          SELECT d::date AS day
          FROM generate_series(
            ${effectiveStartDate.toISOString()}::date,
            ${lastDay.toISOString()}::date,
            '1 day'::interval
          ) d
        ),
        daily_stats AS (
          -- Aggregate storage across all matching libraries per day
          -- library_stats_daily already has cumulative totals per library per day
          SELECT
            lsd.day::date AS day,
            COALESCE(SUM(lsd.total_size_bytes), 0)::bigint AS total_size_bytes,
            COALESCE(SUM(lsd.total_items), 0)::int AS total_items
          FROM library_stats_daily lsd
          WHERE lsd.day >= ${effectiveStartDate.toISOString()}::date
            AND lsd.day <= ${lastDay.toISOString()}::date
            ${serverFilter}
            ${libraryFilter}
          GROUP BY lsd.day::date
        ),
        filled_data AS (
          -- Join date series with actual stats
          -- Use subquery to carry forward last known value for gaps
          SELECT
            ds.day,
            COALESCE(dst.total_size_bytes, (
              SELECT total_size_bytes FROM daily_stats dst2
              WHERE dst2.day < ds.day ORDER BY dst2.day DESC LIMIT 1
            ), 0)::bigint AS total_size_bytes,
            COALESCE(dst.total_items, (
              SELECT total_items FROM daily_stats dst2
              WHERE dst2.day < ds.day ORDER BY dst2.day DESC LIMIT 1
            ), 0)::int AS total_items
          FROM date_series ds
          LEFT JOIN daily_stats dst ON dst.day = ds.day
        )
        SELECT
          fd.day::text,
          fd.total_size_bytes,
          0::bigint AS bytes_added,
          0::int AS items_added,
          fd.total_items
        FROM filled_data fd
        ORDER BY fd.day ASC
      `);

      const rows = result.rows as Array<{
        day: string;
        total_size_bytes: string;
        bytes_added: string;
        items_added: number;
        total_items: number;
      }>;

      // Build history array
      const history: StorageHistoryPoint[] = rows.map((row) => ({
        day: row.day,
        totalSizeBytes: row.total_size_bytes,
      }));

      // Get current stats (latest day)
      const latestRow = rows.length > 0 ? rows[rows.length - 1] : null;

      // Total items comes from the latest snapshot's cumulative total
      const totalItems = latestRow?.total_items ?? 0;

      // Headline total is mirror-deduped live (#478): per-library snapshot
      // sums double-count the same file indexed by several libraries. The
      // trend series above keeps per-library truth; history cannot be
      // deduped retroactively.
      const dedupedResult = await db.execute(sql`
        SELECT ${dedupedStorageBytesSql(
          buildMultiServerFragment(resolvedIds, 'li.server_id'),
          libraryId ? sql`AND li.library_id = ${libraryId}` : sql``
        )}::bigint AS total
      `);
      const dedupedBytes = (dedupedResult.rows[0] as { total: string } | undefined)?.total;

      // Every library in scope, empty ones as zeros. An item counts once however many of its
      // versions are sized, the snapshot rule.
      const librariesResult = await db.execute(sql`
        SELECT
          l.library_id AS "libraryId",
          l.name,
          l.media_type AS "mediaType",
          COALESCE(sized.item_count, 0)::int AS "itemCount",
          COALESCE(sized.size_bytes, 0)::bigint AS "sizeBytes"
        FROM libraries l
        LEFT JOIN (
          SELECT
            li.server_id,
            li.library_id,
            COUNT(DISTINCT li.id) AS item_count,
            SUM(v.file_size) AS size_bytes
          FROM library_items li
          JOIN library_item_versions v
            ON v.library_item_id = li.id AND v.removed_at IS NULL AND v.file_size > 0
          WHERE li.removed_at IS NULL
            ${buildMultiServerFragment(resolvedIds, 'li.server_id')}
          GROUP BY li.server_id, li.library_id
        ) sized ON sized.server_id = l.server_id AND sized.library_id = l.library_id
        WHERE 1=1
          ${buildMultiServerFragment(resolvedIds, 'l.server_id')}
        ORDER BY "sizeBytes" DESC, l.name
      `);
      const libraries: StorageLibraryRow[] = (
        librariesResult.rows as Array<Omit<StorageLibraryRow, 'sizeBytes'> & { sizeBytes: string }>
      ).map((row) => ({ ...row, sizeBytes: Number(row.sizeBytes) }));

      const current = {
        totalSizeBytes: dedupedBytes ?? latestRow?.total_size_bytes ?? '0',
        totalItems,
        lastUpdated: latestRow?.day ?? null,
      };

      // Calculate growth rate using linear regression
      // Use actual day offsets from first data point to handle gaps correctly.
      // The fit never spans the multi-version changeover (see selectGrowthFit);
      // the displayed history keeps the full range either way. Once the
      // snapshot normalization has regenerated pre-changeover history in
      // current semantics there is no step left to guard, so the whole
      // window fits.
      const versionsStamp = await getSetting('mediaVersionsBackfilledAt');
      const normalizedAt = await getSetting('snapshotsNormalizedAt');
      const stampMs =
        versionsStamp && normalizedAt === null ? new Date(versionsStamp).getTime() : null;
      const MIN_DATA_DAYS = 7;
      const fit = selectGrowthFit(rows, stampMs, MIN_DATA_DAYS);
      const firstRow = fit.fitRows[0];
      const firstDate = firstRow ? new Date(firstRow.day).getTime() : 0;

      const dataPoints: DataPoint[] = fit.fitRows.map((row) => ({
        x: Math.round((new Date(row.day).getTime() - firstDate) / TIME_MS.DAY),
        y: Number(row.total_size_bytes),
      }));

      const regression = linearRegression(dataPoints);

      // Calculate actual days spanned (not row count) for data quality checks
      const lastDataPoint = dataPoints[dataPoints.length - 1];
      const lastDayOffset = lastDataPoint?.x ?? 0;
      const fitDays = lastDayOffset + 1; // +1 because day 0 counts as 1 day

      // slope is bytes per day (x is now actual days elapsed)
      const bytesPerDay = regression.slope;
      const growthRate = {
        bytesPerDay: Math.round(bytesPerDay).toString(),
        bytesPerWeek: Math.round(bytesPerDay * 7).toString(),
        bytesPerMonth: Math.round(bytesPerDay * 30).toString(),
        fitDays,
        basis: fit.basis,
      };

      // Predictions extrapolate absolute levels, so unlike the growth slope
      // they can never borrow the pre-changeover side: its levels are
      // old-semantics. They wait for postDaysSpanned to reach the minimum.
      let predictions: LibraryStorageResponse['predictions'];

      if (fit.basis !== 'current' || fit.postDaysSpanned < MIN_DATA_DAYS) {
        predictions = {
          day30: null,
          day90: null,
          day365: null,
          confidence: null,
          minDataDays: MIN_DATA_DAYS,
          currentDataDays: fit.postDaysSpanned,
          message: `Predictions require at least ${MIN_DATA_DAYS} days of data. Currently have ${fit.postDaysSpanned} days.`,
        };
      } else {
        predictions = {
          day30: calculatePrediction(regression, 30, lastDayOffset),
          day90: calculatePrediction(regression, 90, lastDayOffset),
          day365: calculatePrediction(regression, 365, lastDayOffset),
          confidence: getConfidenceLevel(regression.r2),
          minDataDays: MIN_DATA_DAYS,
          currentDataDays: fit.postDaysSpanned,
        };
      }

      const response: LibraryStorageResponse = {
        current,
        history,
        growthRate,
        predictions,
        libraries,
      };

      // Cache for 5 minutes
      await app.redis.setex(fullCacheKey, CACHE_TTL.LIBRARY_STORAGE, JSON.stringify(response));

      return response;
    }
  );
};
