/**
 * Aggregator Job Tests
 *
 * Tests the ACTUAL exported functions from aggregator.ts:
 * - startAggregator: Start the stats refresh interval
 * - stopAggregator: Stop the interval
 * - triggerRefresh: Force an immediate refresh
 *
 * These tests validate:
 * - Interval lifecycle (start/stop)
 * - Double-start prevention
 * - Config merging
 * - Disabled state handling
 * - Immediate execution on start
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import ACTUAL production functions - not local duplicates
import { startAggregator, stopAggregator, triggerRefresh } from '../aggregator.js';

describe('aggregator', () => {
  // Spy on console methods
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Always stop the aggregator to clean up any running intervals
    stopAggregator();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('startAggregator', () => {
    it('should start the aggregator with default config', () => {
      startAggregator();

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Starting stats aggregator')
      );
    });

    it('should log interval time when starting', () => {
      startAggregator({ intervalMs: 30000 });

      expect(consoleLogSpy).toHaveBeenCalledWith('Starting stats aggregator with 30000ms interval');
    });

    it('should run refreshStats immediately on start', () => {
      startAggregator();

      // First call should be the "Starting..." message
      // Second call should be the "Refreshing..." message from immediate run
      expect(consoleLogSpy).toHaveBeenCalledWith('Refreshing dashboard statistics...');
    });

    it('should prevent double start', () => {
      startAggregator();
      consoleLogSpy.mockClear();

      startAggregator();

      expect(consoleLogSpy).toHaveBeenCalledWith('Aggregator already running');
      // Should only log "already running", not start again
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Starting stats aggregator')
      );
    });

    it('should not start when disabled', () => {
      startAggregator({ enabled: false });

      expect(consoleLogSpy).toHaveBeenCalledWith('Stats aggregator disabled');
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Starting stats aggregator')
      );
    });

    it('should run on interval after start', () => {
      startAggregator({ intervalMs: 10000 });
      consoleLogSpy.mockClear();

      // Advance time by interval
      vi.advanceTimersByTime(10000);

      expect(consoleLogSpy).toHaveBeenCalledWith('Refreshing dashboard statistics...');
    });

    it('should run multiple times on interval', () => {
      startAggregator({ intervalMs: 5000 });
      consoleLogSpy.mockClear();

      // Advance 3 intervals
      vi.advanceTimersByTime(5000);
      vi.advanceTimersByTime(5000);
      vi.advanceTimersByTime(5000);

      // Should have run 3 times
      const refreshCalls = consoleLogSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === 'Refreshing dashboard statistics...'
      );
      expect(refreshCalls).toHaveLength(3);
    });

    it('should merge partial config with defaults', () => {
      // Only override intervalMs, enabled should default to true
      startAggregator({ intervalMs: 1000 });

      // Should start (enabled defaults to true)
      expect(consoleLogSpy).toHaveBeenCalledWith('Starting stats aggregator with 1000ms interval');
    });

    it('should use default interval when not specified', () => {
      startAggregator({});

      // Default is POLLING_INTERVALS.STATS_REFRESH = 60000
      expect(consoleLogSpy).toHaveBeenCalledWith('Starting stats aggregator with 60000ms interval');
    });
  });

  describe('stopAggregator', () => {
    it('should stop the aggregator', () => {
      startAggregator();
      consoleLogSpy.mockClear();

      stopAggregator();

      expect(consoleLogSpy).toHaveBeenCalledWith('Stats aggregator stopped');
    });

    it('should allow starting again after stop', () => {
      startAggregator();
      stopAggregator();
      consoleLogSpy.mockClear();

      startAggregator();

      // Should start fresh, not say "already running"
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Starting stats aggregator')
      );
      expect(consoleLogSpy).not.toHaveBeenCalledWith('Aggregator already running');
    });

    it('should do nothing when not running', () => {
      // Don't start first
      stopAggregator();

      // Should not log anything since there's nothing to stop
      expect(consoleLogSpy).not.toHaveBeenCalledWith('Stats aggregator stopped');
    });

    it('should prevent further interval executions', () => {
      startAggregator({ intervalMs: 5000 });
      consoleLogSpy.mockClear();

      stopAggregator();
      consoleLogSpy.mockClear();

      // Advance time - should not trigger refresh
      vi.advanceTimersByTime(5000);
      vi.advanceTimersByTime(5000);

      const refreshCalls = consoleLogSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === 'Refreshing dashboard statistics...'
      );
      expect(refreshCalls).toHaveLength(0);
    });
  });

  describe('triggerRefresh', () => {
    it('should trigger immediate refresh', async () => {
      await triggerRefresh();

      expect(consoleLogSpy).toHaveBeenCalledWith('Refreshing dashboard statistics...');
    });

    it('should work independently of aggregator state', async () => {
      // Don't start aggregator
      await triggerRefresh();

      expect(consoleLogSpy).toHaveBeenCalledWith('Refreshing dashboard statistics...');
    });

    it('should work while aggregator is running', async () => {
      startAggregator({ intervalMs: 60000 });
      consoleLogSpy.mockClear();

      await triggerRefresh();

      expect(consoleLogSpy).toHaveBeenCalledWith('Refreshing dashboard statistics...');
    });

    it('should be awaitable', async () => {
      const promise = triggerRefresh();

      // Should be a promise
      expect(promise).toBeInstanceOf(Promise);

      // Should resolve without error
      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe('lifecycle scenarios', () => {
    it('should handle start-stop-start-stop cycle', () => {
      startAggregator();
      stopAggregator();
      startAggregator();
      stopAggregator();

      // Should have logged "stopped" twice
      const stopCalls = consoleLogSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === 'Stats aggregator stopped'
      );
      expect(stopCalls).toHaveLength(2);
    });

    it('should handle multiple stop calls gracefully', () => {
      startAggregator();
      stopAggregator();
      stopAggregator();
      stopAggregator();

      // Only first stop should log
      const stopCalls = consoleLogSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === 'Stats aggregator stopped'
      );
      expect(stopCalls).toHaveLength(1);
    });

    it('should handle start with disabled then start with enabled', () => {
      startAggregator({ enabled: false });
      consoleLogSpy.mockClear();

      startAggregator({ enabled: true });

      // Second call should start (since disabled didn't create interval)
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Starting stats aggregator')
      );
    });
  });
});
