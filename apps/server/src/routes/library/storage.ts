/**
 * Library Storage Analytics Route
 *
 * GET /storage - Storage usage, trends, and linear regression predictions
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  TIME_MS,
  libraryStorageQuerySchema,
  type LibraryStorageQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';
import { buildLibraryServerFilter, buildLibraryCacheKey } from './utils.js';

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
// Response Types
// ============================================================================

interface StorageHistoryPoint {
  day: string;
  totalSizeBytes: string;
}

interface StoragePrediction {
  predicted: string;
  min: string;
  max: string;
}

interface LibraryStorageResponse {
  current: {
    totalSizeBytes: string;
    totalItems: number;
    lastUpdated: string | null;
  };
  history: StorageHistoryPoint[];
  growthRate: {
    bytesPerDay: string;
    bytesPerWeek: string;
    bytesPerMonth: string;
  };
  predictions: {
    day30: StoragePrediction | null;
    day90: StoragePrediction | null;
    day365: StoragePrediction | null;
    confidence: 'high' | 'medium' | 'low' | null;
    minDataDays: number;
    currentDataDays: number;
    message?: string;
  };
}

// ============================================================================
// Route Implementation
// ============================================================================

/**
 * Calculate start date based on period string.
 */
function getStartDate(period: '7d' | '30d' | '90d' | '1y' | 'all'): Date | null {
  const now = new Date();
  switch (period) {
    case '7d':
      return new Date(now.getTime() - 7 * TIME_MS.DAY);
    case '30d':
      return new Date(now.getTime() - 30 * TIME_MS.DAY);
    case '90d':
      return new Date(now.getTime() - 90 * TIME_MS.DAY);
    case '1y':
      return new Date(now.getTime() - 365 * TIME_MS.DAY);
    case 'all':
      return null;
  }
}

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
   */
  app.get<{ Querystring: LibraryStorageQueryInput }>(
    '/storage',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryStorageQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, libraryId, period, timezone } = query.data;
      const authUser = request.user;
      const tz = timezone ?? 'UTC';

      // Validate server access if specific server requested
      if (serverId) {
        const error = validateServerAccess(authUser, serverId);
        if (error) {
          return reply.forbidden(error);
        }
      }

      // Build cache key with all varying params
      const cacheKey = buildLibraryCacheKey(REDIS_KEYS.LIBRARY_STORAGE, serverId, period, tz);
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

      // Calculate date range
      const startDate = getStartDate(period);

      // Build server filter
      const serverFilter = buildLibraryServerFilter(serverId, authUser);

      // Optional library filter
      const libraryFilter = libraryId ? sql`AND library_id = ${libraryId}` : sql``;

      // Date filter (only if not 'all')
      const dateFilter = startDate ? sql`AND day >= ${startDate.toISOString()}::date` : sql``;

      // Query library_stats_daily aggregate for historical data
      const result = await db.execute(sql`
        SELECT
          day::text AS day,
          COALESCE(SUM(total_size_bytes), 0)::bigint AS total_size_bytes,
          COALESCE(SUM(total_items), 0)::int AS total_items
        FROM library_stats_daily
        WHERE true
          ${serverFilter}
          ${libraryFilter}
          ${dateFilter}
        GROUP BY day
        ORDER BY day ASC
      `);

      const rows = result.rows as Array<{
        day: string;
        total_size_bytes: string;
        total_items: number;
      }>;

      // Build history array
      const history: StorageHistoryPoint[] = rows.map((row) => ({
        day: row.day,
        totalSizeBytes: row.total_size_bytes,
      }));

      // Get current stats (latest day)
      const latestRow = rows.length > 0 ? rows[rows.length - 1] : null;
      const current = {
        totalSizeBytes: latestRow?.total_size_bytes ?? '0',
        totalItems: latestRow?.total_items ?? 0,
        lastUpdated: latestRow?.day ?? null,
      };

      // Calculate growth rate using linear regression
      // Use actual day offsets from first data point to handle gaps correctly
      const firstRow = rows[0];
      const firstDate = firstRow ? new Date(firstRow.day).getTime() : 0;
      const MS_PER_DAY = 24 * 60 * 60 * 1000;

      const dataPoints: DataPoint[] = rows.map((row) => ({
        x: Math.round((new Date(row.day).getTime() - firstDate) / MS_PER_DAY),
        y: Number(row.total_size_bytes),
      }));

      const regression = linearRegression(dataPoints);

      // Calculate actual days spanned (not row count) for data quality checks
      const MIN_DATA_DAYS = 7;
      const lastDataPoint = dataPoints[dataPoints.length - 1];
      const lastDayOffset = lastDataPoint?.x ?? 0;
      const actualDaysSpanned = lastDayOffset + 1; // +1 because day 0 counts as 1 day

      // slope is bytes per day (x is now actual days elapsed)
      const bytesPerDay = regression.slope;
      const growthRate = {
        bytesPerDay: Math.round(bytesPerDay).toString(),
        bytesPerWeek: Math.round(bytesPerDay * 7).toString(),
        bytesPerMonth: Math.round(bytesPerDay * 30).toString(),
      };

      let predictions: LibraryStorageResponse['predictions'];

      if (actualDaysSpanned < MIN_DATA_DAYS) {
        predictions = {
          day30: null,
          day90: null,
          day365: null,
          confidence: null,
          minDataDays: MIN_DATA_DAYS,
          currentDataDays: actualDaysSpanned,
          message: `Predictions require at least ${MIN_DATA_DAYS} days of data. Currently have ${actualDaysSpanned} days.`,
        };
      } else {
        predictions = {
          day30: calculatePrediction(regression, 30, lastDayOffset),
          day90: calculatePrediction(regression, 90, lastDayOffset),
          day365: calculatePrediction(regression, 365, lastDayOffset),
          confidence: getConfidenceLevel(regression.r2),
          minDataDays: MIN_DATA_DAYS,
          currentDataDays: actualDaysSpanned,
        };
      }

      const response: LibraryStorageResponse = {
        current,
        history,
        growthRate,
        predictions,
      };

      // Cache for 5 minutes
      await app.redis.setex(fullCacheKey, CACHE_TTL.LIBRARY_STORAGE, JSON.stringify(response));

      return response;
    }
  );
};
