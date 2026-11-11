import { checkAggregateNeedsRebuild, refreshAggregates } from '../../db/timescale.js';
import { enqueueMaintenanceJob } from '../../jobs/maintenanceQueue.js';

const AGGREGATE_BUFFER_MS = 24 * 60 * 60 * 1000;

/**
 * Refresh the aggregates over the span an import wrote, a day either side, and queue a full
 * rebuild on a fresh install. A failure is logged under the importer's tag and never fails it.
 */
export async function refreshImportAggregates(
  tag: string,
  minDate: Date | null,
  maxDate: Date | null
): Promise<void> {
  try {
    if (minDate && maxDate) {
      const startTime = new Date(minDate.getTime() - AGGREGATE_BUFFER_MS);
      const endTime = new Date(maxDate.getTime() + AGGREGATE_BUFFER_MS);
      console.log(
        `[${tag}] Refreshing aggregates for date range: ${startTime.toISOString()} to ${endTime.toISOString()}`
      );
      await refreshAggregates({ startTime, endTime });
    } else {
      await refreshAggregates();
    }

    const rebuildStatus = await checkAggregateNeedsRebuild();
    if (rebuildStatus.needsRebuild) {
      console.log(
        `[${tag}] Fresh install detected - queueing safe aggregate rebuild: ${rebuildStatus.reason}`
      );
      try {
        await enqueueMaintenanceJob('full_aggregate_rebuild', 'system');
      } catch {
        console.log(`[${tag}] Could not queue aggregate rebuild (may already be running)`);
      }
    }
  } catch (err) {
    console.warn(`[${tag}] Failed to refresh aggregates after import:`, err);
  }
}
