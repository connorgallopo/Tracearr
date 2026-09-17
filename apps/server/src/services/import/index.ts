/**
 * Import Utilities
 *
 * Shared modules for session import operations.
 * Used by Tautulli and Jellystat importers.
 */

// Deduplication
export {
  type ExistingSession,
  type DeduplicationResult,
  type DeduplicationConfig,
  type TimeBounds,
  queryExistingByExternalIds,
  queryExistingByTimeKeys,
  createTimeKey,
  deduplicateBatch,
  createDeduplicationContext,
} from './deduplication.js';

// User Mapping
export {
  createUserMapping,
  lookupUser,
  type SkippedUser,
  createSkippedUserTracker,
} from './userMapping.js';

// Batch Processing
export {
  type NewSession,
  type SessionUpdate,
  type InsertBatchOptions,
  type UpdateBatchOptions,
  flushInsertBatch,
  flushUpdateBatch,
  createInsertBatchCollector,
  createUpdateBatchCollector,
} from './batchProcessor.js';

// Progress Tracking
export {
  type ProgressTrackerConfig,
  createProgressTracker,
  createSimpleProgressPublisher,
} from './progressTracker.js';

// Media Enrichment
export {
  type MediaEnrichment,
  type MediaServerClientWithItems,
  fetchMediaEnrichment,
} from './mediaEnrichment.js';

// Tracking Cutoff
export { getServerTrackingStart } from './trackingCutoff.js';

// Runtime Bound
export { RUNTIME_SLACK_MS, exceedsRuntime } from './runtimeBound.js';
