import { sql, type SQL } from 'drizzle-orm';
import { getSessionChunkRanges, getTimescaleStatus } from '../db/timescale.js';

export interface BackfillWindow {
  /** Inclusive lower bound on started_at */
  start?: Date;
  /** Exclusive upper bound on started_at */
  end?: Date;
}

export interface BackfillWalkResult {
  total: number;
  earliest: Date | null;
  /** Human-readable time ranges that errored and were skipped */
  failedRanges: string[];
}

/** Wraps a runBatch failure so the chunk loop can tell it from an abort signal
 *  (e.g. a lost job lock thrown by onBatch, which must fail the whole walk). */
export class BackfillRangeError extends Error {
  constructor(override readonly cause: unknown) {
    super(`range batch failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export const ts = (date: Date): SQL => sql`${date.toISOString()}::timestamptz`;

/** Orders started_at strings by instant, ties broken by the string itself. */
export function byInstant(a: string, b: string): number {
  return new Date(a).getTime() - new Date(b).getTime() || (a < b ? -1 : a > b ? 1 : 0);
}

/** Deepest bisection of a failing chunk: 30 days / 2^5 is roughly a day. */
const MAX_BISECT_DEPTH = 5;

/** A fault that hits this many distinct ranges isn't a per-chunk decompression
 *  problem - abort instead of grinding through every remaining chunk. Must
 *  exceed 2^MAX_BISECT_DEPTH (32) so one pathologically dense chunk's worth
 *  of day-level leaves can never trip this alone; a genuinely dead database
 *  still aborts after roughly two chunks of leaves. */
const WALK_FAILURE_ABORT_THRESHOLD = 40;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The windows a session maintenance walk drains: every sessions chunk ending
 * after minStart, newest first. Null when sessions is a plain table, where one
 * unwindowed batch loop decompresses nothing.
 */
export async function sessionWalkWindows(
  minStart: Date | null
): Promise<Required<BackfillWindow>[] | null> {
  const status = await getTimescaleStatus();
  if (!status.extensionInstalled || !status.sessionsIsHypertable) return null;
  const ranges = await getSessionChunkRanges();
  return minStart ? ranges.filter((range) => range.end > minStart) : ranges;
}

/**
 * Drain each window in turn, looping batches until one comes back short. Null
 * windows drain once unwindowed, and a batch failure there rejects.
 *
 * A window whose batch errors is halved and retried down to day-level leaves
 * before the range is recorded and skipped, so a chunk dense enough to trip
 * the decompression cap on a whole-chunk window degrades to slower rather than
 * permanently failed - one bad range can't block the rest of history either
 * way. Once WALK_FAILURE_ABORT_THRESHOLD ranges have failed the walk rejects
 * instead of continuing; that many failures means the database, not the
 * chunks.
 */
export async function drainWindowsWithBisection(
  windows: Required<BackfillWindow>[] | null,
  runBatch: (
    window: Required<BackfillWindow> | null
  ) => Promise<{ count: number; oldest: Date | null }>,
  opts: {
    batchSize: number;
    label: string;
    /** Called after every batch with the running total (progress + lock extension) */
    onBatch?: (total: number) => Promise<void>;
  }
): Promise<BackfillWalkResult> {
  const { batchSize, label, onBatch } = opts;
  let total = 0;
  let earliest: Date | null = null;
  const failedRanges: string[] = [];

  const drain = async (window: Required<BackfillWindow> | null) => {
    for (;;) {
      let batch: { count: number; oldest: Date | null };
      try {
        batch = await runBatch(window);
      } catch (err) {
        throw new BackfillRangeError(err);
      }
      total += batch.count;
      if (batch.oldest && (!earliest || batch.oldest < earliest)) earliest = batch.oldest;
      // Deliberately outside the try: onBatch extends the job lock, and a lost
      // lock must abort the whole walk, never be recorded as a failed range.
      await onBatch?.(total);
      if (batch.count < batchSize) break;
    }
  };

  const drainRange = async (window: Required<BackfillWindow>, depth: number): Promise<void> => {
    try {
      await drain(window);
    } catch (err) {
      if (!(err instanceof BackfillRangeError)) throw err;
      const span = window.end.getTime() - window.start.getTime();
      if (depth >= MAX_BISECT_DEPTH || span <= DAY_MS) {
        const range = `${window.start.toISOString()} → ${window.end.toISOString()}`;
        failedRanges.push(range);
        console.error(`[${label}] Range ${range} failed, continuing:`, err.cause);
        if (failedRanges.length >= WALK_FAILURE_ABORT_THRESHOLD) {
          // Plain Error, not BackfillRangeError: every catch above rethrows
          // anything that isn't a range failure, so this leaves the walk.
          throw new Error(
            `Aborting walk: ${failedRanges.length} failed ranges - this looks like a systemic fault (connectivity, permissions), not per-chunk decompression`,
            { cause: err }
          );
        }
        return;
      }
      const mid = new Date(window.start.getTime() + Math.floor(span / 2));
      await drainRange({ start: window.start, end: mid }, depth + 1);
      await drainRange({ start: mid, end: window.end }, depth + 1);
    }
  };

  if (windows === null) {
    await drain(null);
  } else {
    for (const window of windows) {
      await drainRange(window, 0);
    }
  }

  return { total, earliest, failedRanges };
}
