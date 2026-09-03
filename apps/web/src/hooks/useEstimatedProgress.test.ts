import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ActiveSession } from '@tracearr/shared';
import { useEstimatedProgress } from './useEstimatedProgress';

afterEach(() => {
  vi.useRealTimers();
});

function session(over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id: 's1',
    state: 'playing',
    progressMs: 10_000,
    totalDurationMs: 100_000,
    ...over,
  } as ActiveSession;
}

describe('useEstimatedProgress', () => {
  it('starts at the server progress', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useEstimatedProgress(session()));
    expect(result.current.estimatedProgressMs).toBe(10_000);
    expect(result.current.progressPercent).toBe(10);
  });

  it('advances by wall-clock elapsed while playing', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useEstimatedProgress(session()));

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(result.current.estimatedProgressMs).toBe(15_000);
  });

  it('does not advance while paused', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useEstimatedProgress(session({ state: 'paused' })));

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(result.current.estimatedProgressMs).toBe(10_000);
    expect(result.current.isEstimating).toBe(false);
  });

  it('re-anchors when the server sends new progress', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ s }) => useEstimatedProgress(s), {
      initialProps: { s: session() },
    });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current.estimatedProgressMs).toBe(15_000);

    rerender({ s: session({ progressMs: 60_000 }) });
    expect(result.current.estimatedProgressMs).toBe(60_000);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current.estimatedProgressMs).toBe(62_000);
  });

  it('re-anchors on a session change', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ s }) => useEstimatedProgress(s), {
      initialProps: { s: session() },
    });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    rerender({ s: session({ id: 's2', progressMs: 0 }) });

    expect(result.current.estimatedProgressMs).toBe(0);
  });

  it('anchors from the resume point when playback restarts after a pause', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ s }) => useEstimatedProgress(s), {
      initialProps: { s: session({ state: 'paused' }) },
    });

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current.estimatedProgressMs).toBe(10_000);

    rerender({ s: session({ state: 'playing' }) });
    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(result.current.estimatedProgressMs).toBe(14_000);
  });

  it('caps at the total duration', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useEstimatedProgress(session({ progressMs: 99_000, totalDurationMs: 100_000 }))
    );

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(result.current.estimatedProgressMs).toBe(100_000);
    expect(result.current.progressPercent).toBe(100);
  });
});
