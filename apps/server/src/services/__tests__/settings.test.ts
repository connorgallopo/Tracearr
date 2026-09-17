/**
 * Settings cache tests
 *
 * getSetting() is read once per server per poll tick (getGeoIPSettings), so
 * results are cached in-process. Verifies write-through updates from
 * setSetting/setSettings and the TTL fallback for multi-instance staleness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockDbSelect = vi.fn();
const mockDbInsertValues = vi.fn();
const mockOnConflictDoUpdate = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: () => ({ values: mockDbInsertValues }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: () => ({ values: mockDbInsertValues }),
      };
      await fn(tx);
    },
  },
}));

vi.mock('../../db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual };
});

import {
  getGeoIPSettings,
  getImportedHistoryLinkState,
  getSetting,
  getSettings,
  getWatchedThreshold,
  getWatchedThresholds,
  resetSettingsCache,
  setSetting,
  setSettings,
  watchedThresholdFor,
} from '../settings.js';

function mockSettingRow(value: unknown) {
  mockDbSelect.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(value === undefined ? [] : [{ value }]),
      }),
    }),
  });
}

/** Mocks the plural `.where()` (no `.limit()`) query shape getSettings issues for its cache misses. */
function mockSettingRows(rows: Array<{ name: string; value: unknown }>) {
  mockDbSelect.mockReturnValue({
    from: () => ({
      where: () => Promise.resolve(rows),
    }),
  });
}

describe('settings cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSettingsCache();
    mockDbInsertValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
    mockOnConflictDoUpdate.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('only queries the database once for repeated reads within the TTL', async () => {
    mockSettingRow(true);

    await getSetting('usePlexGeoip');
    await getSetting('usePlexGeoip');
    await getGeoIPSettings();

    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it('reflects a setSetting write immediately in-process, within one write', async () => {
    mockSettingRow(false);
    const before = await getGeoIPSettings();
    expect(before.usePlexGeoip).toBe(false);

    await setSetting('usePlexGeoip', true);

    const after = await getGeoIPSettings();
    expect(after.usePlexGeoip).toBe(true);
    // The write-through cache update means no extra SELECT was needed.
    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it('refetches once the TTL expires even without an explicit write', async () => {
    mockSettingRow(false);
    await getSetting('usePlexGeoip');
    expect(mockDbSelect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001);

    mockSettingRow(true);
    const value = await getSetting('usePlexGeoip');
    expect(value).toBe(true);
    expect(mockDbSelect).toHaveBeenCalledTimes(2);
  });

  it('writes multiple settings in a single upsert, not a per-key transaction', async () => {
    await setSettings({ usePlexGeoip: true, mobileEnabled: true });

    // One batched insert covering both keys - no transaction, no per-key round trip.
    expect(mockDbInsertValues).toHaveBeenCalledTimes(1);
    const rows = mockDbInsertValues.mock.calls[0]?.[0];
    expect(rows).toEqual([
      { name: 'usePlexGeoip', value: true },
      { name: 'mobileEnabled', value: true },
    ]);

    // Both values are cached write-through, so reads need no SELECT.
    expect(await getSetting('usePlexGeoip')).toBe(true);
    expect(await getSetting('mobileEnabled')).toBe(true);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('getSettings (plural) serves cached keys and only queries the DB for misses', async () => {
    mockSettingRow(true);
    await getSetting('usePlexGeoip'); // warms the cache for this one key

    mockSettingRows([{ name: 'mobileEnabled', value: true }]);
    const result = await getSettings(['usePlexGeoip', 'mobileEnabled']);

    expect(result).toEqual({ usePlexGeoip: true, mobileEnabled: true });
    // Only the miss (mobileEnabled) round-trips to the DB.
    expect(mockDbSelect).toHaveBeenCalledTimes(2);
  });

  it('getSettings (plural) issues no query at all once every requested key is cached', async () => {
    mockSettingRows([
      { name: 'usePlexGeoip', value: true },
      { name: 'mobileEnabled', value: false },
    ]);
    await getSettings(['usePlexGeoip', 'mobileEnabled']);
    expect(mockDbSelect).toHaveBeenCalledTimes(1);

    const result = await getSettings(['usePlexGeoip', 'mobileEnabled']);
    expect(result).toEqual({ usePlexGeoip: true, mobileEnabled: false });
    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it('getSettings (plural) reflects a setSetting write immediately, without a DB round trip', async () => {
    await setSetting('mobileEnabled', true);

    const result = await getSettings(['mobileEnabled']);
    expect(result).toEqual({ mobileEnabled: true });
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('getSettings (plural) applies defaults for missing rows and caches them, same as getSetting', async () => {
    mockSettingRows([]);
    const first = await getSettings(['mobileEnabled']);
    expect(first).toEqual({ mobileEnabled: false });
    expect(mockDbSelect).toHaveBeenCalledTimes(1);

    const second = await getSettings(['mobileEnabled']);
    expect(second).toEqual({ mobileEnabled: false });
    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });
});

describe('watched thresholds and public API rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSettingsCache();
    mockDbInsertValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
    mockOnConflictDoUpdate.mockResolvedValue(undefined);
  });

  it('defaults to 85/85/85/240 when unset', async () => {
    mockSettingRow(undefined);

    expect(await getSetting('watchedThresholdMovie')).toBe(85);
    expect(await getSetting('watchedThresholdTv')).toBe(85);
    expect(await getSetting('watchedThresholdMusic')).toBe(85);
    expect(await getSetting('publicApiRateLimitPerMinute')).toBe(240);
  });

  it('resolves getWatchedThreshold as a 0-1 fraction per media type', async () => {
    mockSettingRow(undefined);

    expect(await getWatchedThreshold('episode')).toBe(0.85);
    expect(await getWatchedThreshold('track')).toBe(0.85);
    expect(await getWatchedThreshold('movie')).toBe(0.85);
  });

  it('reflects a setSetting write for watchedThresholdTv', async () => {
    mockSettingRow(undefined);

    await setSetting('watchedThresholdTv', 90);

    expect(await getWatchedThreshold('episode')).toBe(0.9);
  });

  it('loads all three thresholds at once and picks one by media type', async () => {
    mockSettingRow(undefined);
    await setSetting('watchedThresholdMusic', 70);

    const thresholds = await getWatchedThresholds();

    expect(thresholds).toEqual({ movie: 0.85, episode: 0.85, track: 0.7 });
    expect(watchedThresholdFor(thresholds, 'track')).toBe(0.7);
    expect(watchedThresholdFor(thresholds, 'episode')).toBe(0.85);
    expect(watchedThresholdFor(thresholds, 'unknown')).toBe(0.85);
  });
});

describe('imported history link state', () => {
  const NOW = new Date('2026-09-17T12:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    resetSettingsCache();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads a stored state without armedAt, or no stored state, as armed now', async () => {
    mockSettingRow({ state: 'pending', providerPassDoneServers: ['s1'], autoAttempts: 2 });
    expect(await getImportedHistoryLinkState()).toEqual({
      state: 'pending',
      providerPassDoneServers: ['s1'],
      autoAttempts: 2,
      generation: 0,
      armedAt: NOW.toISOString(),
    });

    resetSettingsCache();
    mockSettingRow(undefined);
    expect(await getImportedHistoryLinkState()).toMatchObject({ armedAt: NOW.toISOString() });
  });
});
