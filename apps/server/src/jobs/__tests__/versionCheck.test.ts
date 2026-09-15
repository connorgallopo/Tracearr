/**
 * Version Check Queue Tests
 *
 * Tests findBestUpdateForPrerelease, collectUpgradeWarnings, fetchGitHubReleases
 * rate-limit handling, and processVersionCheck's cooldown guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  findBestUpdateForPrerelease,
  fetchGitHubReleases,
  GitHubRateLimitError,
  parseForkReleaseTag,
  compareForkVersions,
  findLatestForkRelease,
  processVersionCheck,
  initVersionCheckQueue,
  scheduleVersionChecks,
  collectUpgradeWarnings,
  type GitHubRelease,
} from '../versionCheckQueue.js';

// ---- module-level mocks needed for processVersionCheck tests ----

interface QueueMockShape {
  add: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getJobSchedulers: ReturnType<typeof vi.fn>;
  removeJobScheduler: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}
const { queueRef } = vi.hoisted(() => ({
  queueRef: { current: null as QueueMockShape | null },
}));
vi.mock('bullmq', () => {
  function MockQueue(this: QueueMockShape) {
    this.add = vi.fn();
    this.close = vi.fn();
    this.getJobSchedulers = vi.fn().mockResolvedValue([]);
    this.removeJobScheduler = vi.fn();
    this.on = vi.fn();
    queueRef.current = this;
  }
  function MockWorker(this: Record<string, unknown>) {
    this.on = vi.fn();
    this.close = vi.fn();
  }
  return { Queue: MockQueue, Worker: MockWorker };
});

vi.mock('../../serverState.js', () => ({ isMaintenance: vi.fn().mockReturnValue(false) }));

const mockDispatchTracearrUpdate = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/automations/events/producers.js', () => ({
  dispatchTracearrUpdate: (...args: unknown[]) => mockDispatchTracearrUpdate(...args),
}));

const mockGetCurrentVersion = vi.fn().mockReturnValue('1.4.0');
vi.mock('../../utils/buildInfo.js', () => ({
  getCurrentVersion: () => mockGetCurrentVersion(),
  getBuildInfo: () => ({ forkVersion: '1.4.0-r1' }),
  getCurrentTag: vi.fn(),
  getCurrentCommit: vi.fn(),
  getBuildDate: vi.fn(),
}));

// Helper to create mock GitHub releases
function mockRelease(tag: string, prerelease: boolean, draft = false): GitHubRelease {
  return {
    tag_name: tag,
    html_url: `https://github.com/test/releases/tag/${tag}`,
    published_at: '2024-01-01T00:00:00Z',
    name: tag,
    body: null,
    prerelease,
    draft,
  };
}

describe('findBestUpdateForPrerelease', () => {
  it('should return newest stable when user is on older prerelease (issue #166)', () => {
    // User on v1.4.1-beta.17, v1.4.3 stable is available
    // Should show v1.4.3, not v1.4.1
    const releases = [
      mockRelease('v1.4.3', false),
      mockRelease('v1.4.3-beta.2', true),
      mockRelease('v1.4.3-beta.1', true),
      mockRelease('v1.4.2', false),
      mockRelease('v1.4.1', false),
      mockRelease('v1.4.1-beta.18', true),
      mockRelease('v1.4.1-beta.17', true),
    ];

    const result = findBestUpdateForPrerelease('v1.4.1-beta.17', releases);
    expect(result?.tag_name).toBe('v1.4.3');
  });

  it('should return same-base stable when no newer stable exists', () => {
    // User on v1.4.1-beta.17, latest stable is v1.4.1
    const releases = [
      mockRelease('v1.4.1', false),
      mockRelease('v1.4.1-beta.18', true),
      mockRelease('v1.4.1-beta.17', true),
    ];

    const result = findBestUpdateForPrerelease('v1.4.1-beta.17', releases);
    expect(result?.tag_name).toBe('v1.4.1');
  });

  it('should return newer prerelease when no stable is newer', () => {
    // User on v1.4.1-beta.17, newer beta exists but no newer stable
    const releases = [
      mockRelease('v1.4.0', false), // older stable
      mockRelease('v1.4.1-beta.18', true),
      mockRelease('v1.4.1-beta.17', true),
    ];

    const result = findBestUpdateForPrerelease('v1.4.1-beta.17', releases);
    expect(result?.tag_name).toBe('v1.4.1-beta.18');
  });

  it('should offer the newest prerelease when a new beta line exists past the latest stable', () => {
    // User on v1.5.0-beta.7 with 2.0.0-beta.1 released: the newest release
    // wins, not the 1.5.0 stable that merely outranks the user's own tag
    const releases = [
      mockRelease('v2.0.0-beta.1', true),
      mockRelease('v1.5.0', false),
      mockRelease('v1.5.0-beta.7', true),
    ];

    const result = findBestUpdateForPrerelease('v1.5.0-beta.7', releases);
    expect(result?.tag_name).toBe('v2.0.0-beta.1');
  });

  it('should return null when already on latest', () => {
    const releases = [mockRelease('v1.4.1-beta.17', true), mockRelease('v1.4.0', false)];

    const result = findBestUpdateForPrerelease('v1.4.1-beta.17', releases);
    expect(result).toBeNull();
  });

  it('should skip draft releases', () => {
    const releases = [
      mockRelease('v1.5.0', false, true), // draft - should be skipped
      mockRelease('v1.4.2', false),
    ];

    const result = findBestUpdateForPrerelease('v1.4.1-beta.17', releases);
    expect(result?.tag_name).toBe('v1.4.2');
  });

  it('should handle unsorted release list', () => {
    // Releases not in order - function should sort them
    const releases = [
      mockRelease('v1.4.1', false),
      mockRelease('v1.4.3', false),
      mockRelease('v1.4.2', false),
    ];

    const result = findBestUpdateForPrerelease('v1.4.1-beta.17', releases);
    expect(result?.tag_name).toBe('v1.4.3');
  });
});

describe('fork release versions', () => {
  it('parses the supported fork tag format', () => {
    expect(parseForkReleaseTag('v1.5.0-r2')).toMatchObject({
      upstreamVersion: '1.5.0',
      forkRevision: 2,
      forkVersion: '1.5.0-r2',
    });
    expect(parseForkReleaseTag('v1.5.0')).toBeNull();
    expect(parseForkReleaseTag('v1.5.0-rx')).toBeNull();
  });

  it('orders upstream semver before fork revision', () => {
    expect(compareForkVersions('1.6.0-r1', '1.5.0-r999')).toBeGreaterThan(0);
    expect(compareForkVersions('1.5.0-r10', '1.5.0-r9')).toBeGreaterThan(0);
  });

  it('ignores malformed and draft releases when selecting the newest fork release', () => {
    expect(
      findLatestForkRelease([
        mockRelease('v9.0.0', false),
        mockRelease('v1.5.0-r3', false),
        mockRelease('v1.6.0-r1', false, true),
        mockRelease('v1.5.0-r2', false),
      ])?.tag_name
    ).toBe('v1.5.0-r3');
  });
});

// ============================================================================
// fetchGitHubReleases — rate-limit error handling
// ============================================================================

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockRateLimitResponse(headers: Record<string, string> = {}, status = 429) {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: vi.fn(),
  };
}

describe('fetchGitHubReleases', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('throws GitHubRateLimitError with seconds from retry-after header', async () => {
    // 1800s is within the [900, 21600] clamp so it passes through unchanged
    mockFetch.mockResolvedValue(mockRateLimitResponse({ 'retry-after': '1800' }, 429));
    const err = await fetchGitHubReleases('https://api.github.com/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubRateLimitError).retryAfterSeconds).toBe(1800);
  });

  it('throws GitHubRateLimitError with seconds from x-ratelimit-reset when retry-after absent', async () => {
    // 30 min from now — above the 15min clamp floor
    const wait = 30 * 60;
    const resetEpoch = Math.floor(Date.now() / 1000) + wait;
    mockFetch.mockResolvedValue(
      mockRateLimitResponse({ 'x-ratelimit-reset': String(resetEpoch) }, 403)
    );
    const err = await fetchGitHubReleases('https://api.github.com/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    const secs = (err as GitHubRateLimitError).retryAfterSeconds;
    // Allow a few seconds of test execution drift
    expect(secs).toBeGreaterThanOrEqual(wait - 5);
    expect(secs).toBeLessThanOrEqual(wait + 5);
  });

  it('clamps retryAfterSeconds to minimum of 15 min when header is tiny', async () => {
    mockFetch.mockResolvedValue(mockRateLimitResponse({ 'retry-after': '5' }, 429));
    const err = await fetchGitHubReleases('https://api.github.com/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubRateLimitError).retryAfterSeconds).toBe(15 * 60);
  });

  it('clamps retryAfterSeconds to maximum of 6 h when header is huge', async () => {
    mockFetch.mockResolvedValue(mockRateLimitResponse({ 'retry-after': '999999' }, 429));
    const err = await fetchGitHubReleases('https://api.github.com/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubRateLimitError).retryAfterSeconds).toBe(6 * 60 * 60);
  });

  it('defaults to 1 h when no rate-limit headers are present', async () => {
    mockFetch.mockResolvedValue(mockRateLimitResponse({}, 403));
    const err = await fetchGitHubReleases('https://api.github.com/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    // 3600 is clamped within [900, 21600] so stays at 3600
    expect((err as GitHubRateLimitError).retryAfterSeconds).toBe(3600);
  });

  it('falls back to 1 h when retry-after is an HTTP-date instead of seconds', async () => {
    mockFetch.mockResolvedValue(
      mockRateLimitResponse({ 'retry-after': 'Thu, 01 Jan 2026 00:00:00 GMT' }, 429)
    );
    const err = await fetchGitHubReleases('https://api.github.com/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubRateLimitError).retryAfterSeconds).toBe(3600);
  });
});

// ============================================================================
// processVersionCheck — cooldown guard and rate-limit recovery
// ============================================================================

// Single shared redis mock — initVersionCheckQueue only accepts the first call per module
// instance, so we control behavior via mockResolvedValueOnce per test.
const sharedRedis = {
  exists: vi.fn(),
  set: vi.fn().mockResolvedValue('OK'),
  get: vi.fn().mockResolvedValue(null),
};

// Initialise once; subsequent calls are no-ops due to the guard in the module.
initVersionCheckQueue('redis://localhost', sharedRedis as never, vi.fn());

function makeJob(force?: boolean) {
  return { id: 'test-job', data: { type: 'check' as const, force } } as Parameters<
    typeof processVersionCheck
  >[0];
}

describe('processVersionCheck', () => {
  beforeEach(() => {
    mockFetch.mockReset().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue([]),
    });
    sharedRedis.exists.mockReset();
    sharedRedis.set.mockReset().mockResolvedValue('OK');
    mockDispatchTracearrUpdate.mockClear();
    mockGetCurrentVersion.mockReturnValue('1.4.0');
  });

  it('skips GitHub fetch when cooldown key exists and force is false', async () => {
    sharedRedis.exists.mockResolvedValue(1); // cooldown active
    await processVersionCheck(makeJob(false));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT skip when force is true even if cooldown key exists', async () => {
    sharedRedis.exists.mockResolvedValue(1); // cooldown active — but force overrides
    const latestRelease: GitHubRelease = {
      tag_name: 'v1.4.0',
      html_url: 'https://github.com/test/releases/tag/v1.4.0',
      published_at: '2024-01-01T00:00:00Z',
      name: 'v1.4.0',
      body: null,
      prerelease: false,
      draft: false,
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(latestRelease),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue([mockRelease('v1.4.0-r1', true)]),
    });
    await processVersionCheck(makeJob(true));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('sets cooldown key on rate-limit and returns without throwing', async () => {
    sharedRedis.exists.mockResolvedValue(0); // no cooldown
    mockFetch.mockResolvedValue(mockRateLimitResponse({ 'retry-after': '1800' }, 429));
    // Must not throw
    await expect(processVersionCheck(makeJob(false))).resolves.toBeUndefined();
    // Cooldown key must be set with the rate-limit TTL
    expect(sharedRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('version:check:cooldown'),
      '1',
      'EX',
      1800
    );
  });

  it('sets cooldown key after a successful fetch', async () => {
    sharedRedis.exists.mockResolvedValue(0); // no cooldown
    const latestRelease: GitHubRelease = {
      tag_name: 'v1.5.0',
      html_url: 'https://github.com/test/releases/tag/v1.5.0',
      published_at: '2024-01-01T00:00:00Z',
      name: 'v1.5.0',
      body: null,
      prerelease: false,
      draft: false,
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(latestRelease),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue([mockRelease('v1.5.0-r1', true)]),
    });
    await processVersionCheck(makeJob(false));
    expect(sharedRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('version:latest:upstream'),
      expect.any(String),
      'EX',
      expect.any(Number)
    );
    expect(sharedRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('version:latest:fork'),
      expect.any(String),
      'EX',
      expect.any(Number)
    );
    const forkCacheWrite = sharedRedis.set.mock.calls.find(([key]) =>
      String(key).includes('version:latest:fork')
    );
    expect(forkCacheWrite).toBeDefined();
    expect(JSON.parse(String(forkCacheWrite?.[1])).isPrerelease).toBe(false);
    expect(sharedRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('version:check:cooldown'),
      '1',
      'EX',
      15 * 60
    );
  });

  it('dispatches tracearr.update_available when the release is newer', async () => {
    sharedRedis.exists.mockResolvedValue(0);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        tag_name: 'v1.5.0',
        html_url: 'https://github.com/test/releases/tag/v1.5.0',
        published_at: '2024-01-01T00:00:00Z',
        name: 'v1.5.0',
        body: null,
        prerelease: false,
        draft: false,
      } satisfies GitHubRelease),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue([mockRelease('v1.5.0-r1', false)]),
    });

    await processVersionCheck(makeJob(false));

    expect(mockDispatchTracearrUpdate).toHaveBeenCalledWith({
      current: '1.4.0',
      latest: '1.5.0-r1',
      releaseUrl: 'https://github.com/test/releases/tag/v1.5.0-r1',
    });
  });

  it('limits fork upgrade warnings to its upstream base when upstream is ahead', async () => {
    sharedRedis.exists.mockResolvedValue(0);
    const releases = ['1.5.0', '1.6.0'].map((version) => ({
      ...mockRelease(`v${version}`, false),
      assets: [
        { name: 'release-notes.json', browser_download_url: `https://example.test/${version}` },
      ],
    }));
    mockFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => {
        if (url.includes('d4rk-4lchemy')) return [mockRelease('v1.5.0-r2', true)];
        if (url.endsWith('/releases/latest')) return releases[1];
        if (url.includes('/releases?')) return releases;
        const version = url.split('/').at(-1);
        return {
          version,
          date: '2026-01-01',
          headline: 'Release',
          upgradeWarning: `Warning ${version}`,
          changes: [{ type: 'fix', text: 'Fix' }],
        };
      },
    }));

    await processVersionCheck(makeJob(false));

    const cached = (source: string) => {
      const write = sharedRedis.set.mock.calls.find(([key]) =>
        String(key).endsWith(`version:latest:${source}`)
      );
      return JSON.parse(String(write?.[1]));
    };
    expect(cached('fork').upgradeWarnings).toEqual([{ version: '1.5.0', text: 'Warning 1.5.0' }]);
    expect(cached('upstream').upgradeWarnings).toEqual([
      { version: '1.6.0', text: 'Warning 1.6.0' },
      { version: '1.5.0', text: 'Warning 1.5.0' },
    ]);
    expect(mockDispatchTracearrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ latest: '1.5.0-r2' })
    );
  });

  it('dispatches nothing when the release is not newer', async () => {
    sharedRedis.exists.mockResolvedValue(0);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        tag_name: 'v1.4.0',
        html_url: 'https://github.com/test/releases/tag/v1.4.0',
        published_at: '2024-01-01T00:00:00Z',
        name: 'v1.4.0',
        body: null,
        prerelease: false,
        draft: false,
      } satisfies GitHubRelease),
    });

    await processVersionCheck(makeJob(false));

    expect(mockDispatchTracearrUpdate).not.toHaveBeenCalled();
  });

  it('rethrows non-rate-limit errors and does not set a cooldown', async () => {
    sharedRedis.exists.mockResolvedValue(0); // no cooldown
    mockFetch.mockResolvedValue(mockRateLimitResponse({}, 500));
    await expect(processVersionCheck(makeJob(false))).rejects.toThrow();
    expect(sharedRedis.set).not.toHaveBeenCalled();
  });
});

describe('scheduleVersionChecks', () => {
  it('clears existing schedulers by their key, which is what BullMQ reports', async () => {
    const queue = queueRef.current;
    if (!queue) throw new Error('queue mock not constructed');
    queue.getJobSchedulers.mockResolvedValue([
      { key: 'version-check-repeatable', name: 'scheduled-check' },
    ]);

    await scheduleVersionChecks();

    expect(queue.removeJobScheduler).toHaveBeenCalledWith('version-check-repeatable');
  });
});

describe('collectUpgradeWarnings', () => {
  const release = (tag: string, withAsset: boolean, prerelease = false): GitHubRelease => ({
    tag_name: tag,
    html_url: `https://github.com/test/releases/tag/${tag}`,
    published_at: '2026-01-01T00:00:00Z',
    name: tag,
    body: null,
    prerelease,
    draft: false,
    assets: withAsset
      ? [
          {
            name: 'release-notes.json',
            browser_download_url: `https://example.test/${tag}/release-notes.json`,
          },
        ]
      : [],
  });

  const notes = (version: string, upgradeWarning?: string) => ({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      version,
      date: '2026-01-01',
      ...(version.endsWith('.0') && !version.includes('-') ? { headline: 'Headline' } : {}),
      ...(upgradeWarning ? { upgradeWarning } : {}),
      changes: [{ type: 'fix', text: 'a fix' }],
    }),
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('collects warnings between current and target, newest first', async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/v2.3.0/')
          ? notes('2.3.0', 'back up first')
          : notes('2.2.0', 'update the plugin')
      )
    );

    const warnings = await collectUpgradeWarnings('2.1.0', '2.3.0', [
      release('v2.1.0', true),
      release('v2.2.0', true),
      release('v2.3.0', true),
      release('v2.4.0', true),
    ]);

    expect(warnings).toEqual([
      { version: '2.3.0', text: 'back up first' },
      { version: '2.2.0', text: 'update the plugin' },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('skips releases without the asset and prereleases when the target is stable', async () => {
    mockFetch.mockResolvedValue(notes('2.3.0', 'back up first'));

    const warnings = await collectUpgradeWarnings('2.2.3', '2.3.0', [
      release('v2.3.0-beta.1', true, true),
      release('v2.2.4', false),
      release('v2.3.0', true),
    ]);

    expect(warnings).toEqual([{ version: '2.3.0', text: 'back up first' }]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps going when one download fails', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(notes('2.2.0', 'update the plugin'));

    const warnings = await collectUpgradeWarnings('2.1.0', '2.3.0', [
      release('v2.3.0', true),
      release('v2.2.0', true),
    ]);

    expect(warnings).toEqual([{ version: '2.2.0', text: 'update the plugin' }]);
  });

  it('fetches a shared beta asset once and skips older betas with the same base version', async () => {
    mockFetch.mockResolvedValue(notes('2.3.0', 'back up first'));

    const warnings = await collectUpgradeWarnings('2.2.3', '2.3.0-beta.6', [
      release('v2.3.0-beta.6', true, true),
      release('v2.3.0-beta.5', true, true),
      release('v2.3.0-beta.4', true, true),
    ]);

    expect(warnings).toEqual([{ version: '2.3.0', text: 'back up first' }]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps checking older betas of the same base version until a warning is found', async () => {
    mockFetch
      .mockResolvedValueOnce(notes('2.3.0'))
      .mockResolvedValueOnce(notes('2.3.0', 'back up first'))
      .mockResolvedValueOnce(notes('2.3.0', 'older text'));

    const warnings = await collectUpgradeWarnings('2.2.3', '2.3.0-beta.6', [
      release('v2.3.0-beta.6', true, true),
      release('v2.3.0-beta.5', true, true),
      release('v2.3.0-beta.4', true, true),
    ]);

    expect(warnings).toEqual([{ version: '2.3.0', text: 'back up first' }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
