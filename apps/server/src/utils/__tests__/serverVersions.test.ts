import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../http.js', () => ({ fetchJson: vi.fn() }));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { fetchJson } from '../http.js';
import {
  SERVER_RELEASE_PAGES,
  isNewerServerVersion,
  latestVersionFor,
  normalizeServerVersion,
} from '../serverVersions.js';

const mockFetchJson = vi.mocked(fetchJson);

/** The three shapes the live feeds returned on 2026-08-21. */
const PLEX_FEED = {
  computer: {
    Windows: { version: '1.43.3.10896-cb3ebc72d' },
    MacOS: { version: '1.43.3.10896-cb3ebc72d' },
    Linux: { version: '1.44.0.11000-aa11bb22c' },
  },
};

describe('normalizeServerVersion', () => {
  it('drops the build hash Plex ships with its version', () => {
    expect(normalizeServerVersion('plex', '1.43.3.10896-cb3ebc72d')).toBe('1.43.3.10896');
  });

  it('drops the v Jellyfin tags its releases with', () => {
    expect(normalizeServerVersion('jellyfin', 'v10.11.11')).toBe('10.11.11');
  });

  it('keeps an Emby four-part version as it is', () => {
    expect(normalizeServerVersion('emby', '4.9.5.0')).toBe('4.9.5.0');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeServerVersion('emby', ' 4.9.5.0 ')).toBe('4.9.5.0');
  });

  it('rejects anything that is not dotted digits', () => {
    expect(normalizeServerVersion('plex', 'unknown')).toBeNull();
    expect(normalizeServerVersion('plex', '')).toBeNull();
    expect(normalizeServerVersion('plex', '1.43.x.10896')).toBeNull();
    expect(normalizeServerVersion('jellyfin', 'v10.11.11-rc1')).toBeNull();
    expect(normalizeServerVersion('emby', '4.9.5.0.1')).toBeNull();
  });

  it('rejects a version too short for the comparator to read', () => {
    expect(normalizeServerVersion('emby', '4')).toBeNull();
  });

  it('pads a two part version out to three', () => {
    expect(normalizeServerVersion('jellyfin', 'v12.0')).toBe('12.0.0');
    expect(normalizeServerVersion('plex', '1.43-cb3ebc72d')).toBe('1.43.0');
  });

  it('takes three and four part versions', () => {
    expect(normalizeServerVersion('emby', '4.9.5')).toBe('4.9.5');
    expect(normalizeServerVersion('emby', '4.9.5.0')).toBe('4.9.5.0');
  });
});

describe('isNewerServerVersion', () => {
  it('compares Plex versions with their hashes stripped', () => {
    expect(isNewerServerVersion('plex', '1.44.0.11000-aa11bb22c', '1.43.3.10896-cb3ebc72d')).toBe(
      true
    );
    expect(isNewerServerVersion('plex', '1.43.3.10896-cb3ebc72d', '1.43.3.10896-ffffffff')).toBe(
      false
    );
  });

  it('compares Jellyfin tags against the version the server reports', () => {
    expect(isNewerServerVersion('jellyfin', 'v10.11.12', '10.11.11')).toBe(true);
    expect(isNewerServerVersion('jellyfin', 'v10.11.11', '10.11.11')).toBe(false);
  });

  it('reads the two part tag Jellyfin shipped 12.0 under', () => {
    expect(isNewerServerVersion('jellyfin', 'v12.0', '10.11.11')).toBe(true);
    expect(isNewerServerVersion('jellyfin', 'v12.0', '12.0.0')).toBe(false);
  });

  it('compares all four parts of an Emby version', () => {
    expect(isNewerServerVersion('emby', '4.9.5.0', '4.9.4.90')).toBe(true);
    expect(isNewerServerVersion('emby', '4.9.5.0', '4.9.5.0')).toBe(false);
  });

  it('calls nothing newer when either side is unparseable', () => {
    expect(isNewerServerVersion('emby', '4.9.5.0', 'unknown')).toBe(false);
    expect(isNewerServerVersion('emby', 'unknown', '4.9.4.0')).toBe(false);
  });
});

describe('latestVersionFor', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  it('takes the newest across the Plex platforms', async () => {
    mockFetchJson.mockResolvedValue(PLEX_FEED);

    await expect(latestVersionFor('plex')).resolves.toBe('1.44.0.11000');
    expect(mockFetchJson).toHaveBeenCalledWith(
      'https://plex.tv/api/downloads/5.json',
      expect.objectContaining({ timeout: 10_000, service: 'plex' })
    );
  });

  it('reads the Jellyfin release tag', async () => {
    mockFetchJson.mockResolvedValue({ tag_name: 'v12.0' });

    await expect(latestVersionFor('jellyfin')).resolves.toBe('12.0.0');
    expect(mockFetchJson).toHaveBeenCalledWith(
      'https://api.github.com/repos/jellyfin/jellyfin/releases/latest',
      expect.objectContaining({ timeout: 10_000, service: 'github' })
    );
  });

  it('reads the Emby release tag', async () => {
    mockFetchJson.mockResolvedValue({ tag_name: '4.9.5.0' });

    await expect(latestVersionFor('emby')).resolves.toBe('4.9.5.0');
    expect(mockFetchJson).toHaveBeenCalledWith(
      'https://api.github.com/repos/MediaBrowser/Emby.Releases/releases/latest',
      expect.objectContaining({ timeout: 10_000, service: 'github' })
    );
  });

  it('returns null when the feed cannot be read', async () => {
    mockFetchJson.mockRejectedValue(new Error('network'));

    await expect(latestVersionFor('jellyfin')).resolves.toBeNull();
  });

  it('returns null when the feed carries nothing parseable', async () => {
    mockFetchJson.mockResolvedValue({ tag_name: 'nightly' });

    await expect(latestVersionFor('emby')).resolves.toBeNull();
  });

  it('names a release page per server type', () => {
    expect(SERVER_RELEASE_PAGES.plex).toContain('plex.tv');
    expect(SERVER_RELEASE_PAGES.jellyfin).toContain('jellyfin');
    expect(SERVER_RELEASE_PAGES.emby).toContain('Emby');
  });
});
