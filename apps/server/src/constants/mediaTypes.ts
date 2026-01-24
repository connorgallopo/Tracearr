/**
 * Media Type Constants
 *
 * Centralized definitions for media type filtering across the application.
 * Live TV and music tracks are excluded from primary statistics but tracked separately.
 *
 * IMPORTANT: All SQL fragments are dynamically derived from the TypeScript arrays.
 * Changing PRIMARY_MEDIA_TYPES or EXCLUDED_MEDIA_TYPES will automatically update all SQL.
 */

import { sql } from 'drizzle-orm';
import { MEDIA_TYPES, type MediaType } from '@tracearr/shared';

// Re-export from shared package
export const ALL_MEDIA_TYPES = MEDIA_TYPES;
export type { MediaType };

/**
 * Media types that count toward primary statistics (dashboard, plays, users, etc.)
 * Excludes live TV and music tracks - they have their own breakdowns.
 */
export const PRIMARY_MEDIA_TYPES = ['movie', 'episode'] as const;
export type PrimaryMediaType = (typeof PRIMARY_MEDIA_TYPES)[number];

/**
 * Media types excluded from rule evaluation and primary statistics.
 * Live TV and music tracks typically don't represent sharing/abuse patterns.
 * Photos, trailers and unknown types are also excluded as they're not typical media consumption.
 */
export const EXCLUDED_MEDIA_TYPES = ['live', 'track', 'photo', 'trailer', 'unknown'] as const;
export type ExcludedMediaType = (typeof EXCLUDED_MEDIA_TYPES)[number];

/**
 * Set version of excluded media types for O(1) lookup in hot paths.
 */
export const EXCLUDED_MEDIA_TYPES_SET = new Set<string>(EXCLUDED_MEDIA_TYPES);

// Generate SQL IN clause from array - single source of truth
const primaryTypesInClause = PRIMARY_MEDIA_TYPES.map((t) => `'${t}'`).join(', ');

/**
 * SQL fragment for filtering to primary media types in raw queries.
 * Use this when building dynamic SQL with template literals.
 */
export const MEDIA_TYPE_SQL_FILTER = sql.raw(`AND media_type IN (${primaryTypesInClause})`);

/**
 * SQL fragment without "AND" prefix - for use with sql.join() in query builders.
 * Example: conditions.push(PRIMARY_MEDIA_TYPE_CONDITION)
 */
export const PRIMARY_MEDIA_TYPE_CONDITION = sql.raw(`media_type IN (${primaryTypesInClause})`);

/**
 * SQL fragment with table alias 's.' for sessions table joins.
 * Example: conditions.push(PRIMARY_MEDIA_TYPE_CONDITION_S)
 */
export const PRIMARY_MEDIA_TYPE_CONDITION_S = sql.raw(`s.media_type IN (${primaryTypesInClause})`);

/**
 * SQL fragment with "AND" prefix and 's.' table alias.
 * For use in raw SQL JOIN conditions.
 */
export const MEDIA_TYPE_SQL_FILTER_S = sql.raw(`AND s.media_type IN (${primaryTypesInClause})`);

/**
 * Raw SQL string for use in TimescaleDB continuous aggregate definitions.
 * Used directly in CREATE MATERIALIZED VIEW statements.
 */
export const PRIMARY_MEDIA_TYPES_SQL_LITERAL = `media_type IN (${primaryTypesInClause})`;
