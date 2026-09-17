/**
 * Tracearr's own cap on a session it captures is the media runtime plus this
 * slack (jobs/poller/stateTracker.ts, calculateStopDuration). Imported rows
 * carry no position to cap against, so a row past it is refused instead.
 */
export const RUNTIME_SLACK_MS = 60_000;

export function exceedsRuntime(durationMs: number, runtimeMs: number | null | undefined): boolean {
  if (runtimeMs == null || runtimeMs <= 0) return false;
  return durationMs > runtimeMs + RUNTIME_SLACK_MS;
}
