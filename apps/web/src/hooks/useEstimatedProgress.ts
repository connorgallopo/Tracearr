import { useState, useEffect, useRef } from 'react';
import type { ActiveSession } from '@tracearr/shared';

function parseTimestampMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getEstimatedProgressMs(session: ActiveSession): number {
  const baseProgress = session.progressMs ?? 0;
  if (session.state !== 'playing') return baseProgress;

  const progressUpdatedAtMs = parseTimestampMs(session.progressUpdatedAt);
  if (progressUpdatedAtMs === null) return baseProgress;

  const elapsedMs = Math.max(0, Date.now() - progressUpdatedAtMs);
  const estimatedProgressMs = baseProgress + elapsedMs;
  const maxProgress = session.totalDurationMs ?? Infinity;
  return Math.min(estimatedProgressMs, maxProgress);
}

/**
 * Hook that estimates playback progress client-side for smooth UI updates.
 *
 * NOTE: This hook is duplicated in the mobile repo (Tracearr/Mobile-App,
 * src/hooks/useEstimatedProgress.ts). Keep both files in sync when making changes.
 *
 * When state is "playing", progress increments every second based on elapsed time.
 * When state is "paused" or "stopped", progress stays at last known value.
 *
 * Resets estimation when:
 * - Session ID changes
 * - Server-side progressMs changes (new data from SSE/poll)
 * - State changes
 *
 * @param session - The active session to estimate progress for
 * @returns Object with estimated progressMs and progress percentage
 */
export function useEstimatedProgress(session: ActiveSession) {
  const [estimatedProgressMs, setEstimatedProgressMs] = useState(() => getEstimatedProgressMs(session));

  // Track the last known server values to detect changes
  const lastServerProgress = useRef(session.progressMs);
  const lastProgressUpdatedAt = useRef(session.progressUpdatedAt);
  const lastSessionId = useRef(session.id);
  const lastState = useRef(session.state);
  const estimationStartTime = useRef(0);
  const estimationStartProgress = useRef(session.progressMs ?? 0);

  // Reset estimation when server data changes
  useEffect(() => {
    const serverProgressChanged = session.progressMs !== lastServerProgress.current;
    const progressTimestampChanged = session.progressUpdatedAt !== lastProgressUpdatedAt.current;
    const sessionChanged = session.id !== lastSessionId.current;
    const stateChanged = session.state !== lastState.current;

    if (sessionChanged || serverProgressChanged || progressTimestampChanged || stateChanged) {
      const newProgress = getEstimatedProgressMs(session);
      setEstimatedProgressMs(newProgress);

      lastServerProgress.current = session.progressMs;
      lastProgressUpdatedAt.current = session.progressUpdatedAt;
      lastSessionId.current = session.id;
      lastState.current = session.state;
      estimationStartTime.current =
        parseTimestampMs(session.progressUpdatedAt) ?? Date.now();
      estimationStartProgress.current = session.progressMs ?? 0;
    }
  }, [session.id, session.progressMs, session.progressUpdatedAt, session.state, session.totalDurationMs]);

  // Tick progress when playing
  useEffect(() => {
    if (session.state !== 'playing') {
      return;
    }

    if (estimationStartTime.current === 0) {
      estimationStartTime.current = parseTimestampMs(session.progressUpdatedAt) ?? Date.now();
    }

    const intervalId = setInterval(() => {
      const elapsedMs = Math.max(0, Date.now() - estimationStartTime.current);
      const estimatedProgressMs = estimationStartProgress.current + elapsedMs;
      const maxProgress = session.totalDurationMs ?? Infinity;
      setEstimatedProgressMs(Math.min(estimatedProgressMs, maxProgress));
    }, 1000);

    return () => clearInterval(intervalId);
  }, [session.id, session.progressMs, session.progressUpdatedAt, session.state, session.totalDurationMs]);

  // Calculate percentage
  const progressPercent = session.totalDurationMs
    ? Math.min((estimatedProgressMs / session.totalDurationMs) * 100, 100)
    : 0;

  return {
    estimatedProgressMs,
    progressPercent,
    isEstimating: session.state === 'playing',
  };
}
