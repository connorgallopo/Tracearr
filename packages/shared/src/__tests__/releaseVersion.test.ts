import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  getBaseVersion,
  isNewerVersion,
  isPrerelease,
  normalizeVersion,
  parseVersion,
} from '../releaseVersion.js';

describe('normalizeVersion', () => {
  it('strips a leading v and surrounding space', () => {
    expect(normalizeVersion('v2.3.0-beta.5')).toBe('2.3.0-beta.5');
    expect(normalizeVersion(' 2.2.3 ')).toBe('2.2.3');
  });
});

describe('parseVersion', () => {
  describe('stable versions', () => {
    it('should parse simple version', () => {
      const v = parseVersion('1.3.9');
      expect(v.major).toBe(1);
      expect(v.minor).toBe(3);
      expect(v.patch).toBe(9);
      expect(v.isPrerelease).toBe(false);
      expect(v.prerelease).toBeNull();
      expect(v.prereleaseNum).toBeNull();
    });

    it('should parse version with v prefix', () => {
      const v = parseVersion('v1.3.9');
      expect(v.major).toBe(1);
      expect(v.minor).toBe(3);
      expect(v.patch).toBe(9);
      expect(v.isPrerelease).toBe(false);
    });

    it('should parse version with zeros', () => {
      const v = parseVersion('0.0.1');
      expect(v.major).toBe(0);
      expect(v.minor).toBe(0);
      expect(v.patch).toBe(1);
    });
  });

  describe('prerelease versions', () => {
    it('should parse beta version with number', () => {
      const v = parseVersion('1.3.9-beta.3');
      expect(v.major).toBe(1);
      expect(v.minor).toBe(3);
      expect(v.patch).toBe(9);
      expect(v.isPrerelease).toBe(true);
      expect(v.prerelease).toBe('beta');
      expect(v.prereleaseNum).toBe(3);
    });

    it('should parse alpha version', () => {
      const v = parseVersion('v2.0.0-alpha.1');
      expect(v.major).toBe(2);
      expect(v.minor).toBe(0);
      expect(v.patch).toBe(0);
      expect(v.isPrerelease).toBe(true);
      expect(v.prerelease).toBe('alpha');
      expect(v.prereleaseNum).toBe(1);
    });

    it('should parse rc version', () => {
      const v = parseVersion('1.4.0-rc.2');
      expect(v.major).toBe(1);
      expect(v.minor).toBe(4);
      expect(v.patch).toBe(0);
      expect(v.isPrerelease).toBe(true);
      expect(v.prerelease).toBe('rc');
      expect(v.prereleaseNum).toBe(2);
    });

    it('should handle double-digit prerelease numbers', () => {
      const v = parseVersion('1.3.9-beta.10');
      expect(v.prereleaseNum).toBe(10);
    });
  });

  describe('malformed versions', () => {
    it('should return zeros for empty string', () => {
      const v = parseVersion('');
      expect(v.major).toBe(0);
      expect(v.minor).toBe(0);
      expect(v.patch).toBe(0);
    });

    it('should return zeros for invalid format', () => {
      const v = parseVersion('not-a-version');
      expect(v.major).toBe(0);
      expect(v.minor).toBe(0);
      expect(v.patch).toBe(0);
    });
  });
});

describe('isPrerelease', () => {
  it('should return false for stable versions', () => {
    expect(isPrerelease('1.3.9')).toBe(false);
    expect(isPrerelease('v1.3.9')).toBe(false);
    expect(isPrerelease('0.0.1')).toBe(false);
  });

  it('should return true for beta versions', () => {
    expect(isPrerelease('1.3.9-beta.1')).toBe(true);
    expect(isPrerelease('v1.4.0-beta.3')).toBe(true);
  });

  it('should return true for alpha versions', () => {
    expect(isPrerelease('2.0.0-alpha.1')).toBe(true);
  });

  it('should return true for rc versions', () => {
    expect(isPrerelease('1.4.0-rc.1')).toBe(true);
  });

  it('should return true for other prerelease types', () => {
    expect(isPrerelease('1.0.0-dev.1')).toBe(true);
    expect(isPrerelease('1.0.0-canary.5')).toBe(true);
    expect(isPrerelease('1.0.0-next.2')).toBe(true);
  });
});

describe('getBaseVersion', () => {
  it('should return same version for stable', () => {
    expect(getBaseVersion('1.3.9')).toBe('1.3.9');
    expect(getBaseVersion('v1.3.9')).toBe('1.3.9');
  });

  it('should strip prerelease suffix', () => {
    expect(getBaseVersion('1.3.9-beta.3')).toBe('1.3.9');
    expect(getBaseVersion('v1.4.0-beta.10')).toBe('1.4.0');
    expect(getBaseVersion('2.0.0-alpha.1')).toBe('2.0.0');
  });
});

describe('compareVersions', () => {
  describe('stable version comparisons', () => {
    it('should return 0 for equal versions', () => {
      expect(compareVersions('1.3.9', '1.3.9')).toBe(0);
      expect(compareVersions('v1.3.9', '1.3.9')).toBe(0);
    });

    it('should compare major versions', () => {
      expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
      expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    });

    it('should compare minor versions', () => {
      expect(compareVersions('1.4.0', '1.3.0')).toBe(1);
      expect(compareVersions('1.3.0', '1.4.0')).toBe(-1);
    });

    it('should compare patch versions', () => {
      expect(compareVersions('1.3.10', '1.3.9')).toBe(1);
      expect(compareVersions('1.3.9', '1.3.10')).toBe(-1);
    });
  });

  describe('prerelease vs stable', () => {
    it('should rank stable higher than prerelease of same base', () => {
      // 1.3.9 (stable) > 1.3.9-beta.99
      expect(compareVersions('1.3.9', '1.3.9-beta.99')).toBe(1);
      expect(compareVersions('1.3.9-beta.99', '1.3.9')).toBe(-1);
    });

    it('should rank higher base version prerelease over lower stable', () => {
      // 1.4.0-beta.1 > 1.3.9 (higher major.minor)
      expect(compareVersions('1.4.0-beta.1', '1.3.9')).toBe(1);
      expect(compareVersions('1.3.9', '1.4.0-beta.1')).toBe(-1);
    });
  });

  describe('prerelease comparisons', () => {
    it('should compare same prerelease type by number', () => {
      expect(compareVersions('1.3.9-beta.2', '1.3.9-beta.1')).toBe(1);
      expect(compareVersions('1.3.9-beta.1', '1.3.9-beta.2')).toBe(-1);
      expect(compareVersions('1.3.9-beta.10', '1.3.9-beta.9')).toBe(1);
    });

    it('should compare different prerelease types', () => {
      // alpha < beta < rc
      expect(compareVersions('1.3.9-beta.1', '1.3.9-alpha.1')).toBe(1);
      expect(compareVersions('1.3.9-rc.1', '1.3.9-beta.1')).toBe(1);
      expect(compareVersions('1.3.9-alpha.1', '1.3.9-beta.1')).toBe(-1);
    });

    it('should return 0 for equal prereleases', () => {
      expect(compareVersions('1.3.9-beta.3', '1.3.9-beta.3')).toBe(0);
    });
  });
});

describe('isNewerVersion', () => {
  describe('stable to stable', () => {
    it('should detect newer major version', () => {
      expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true);
      expect(isNewerVersion('1.9.9', '2.0.0')).toBe(false);
    });

    it('should detect newer minor version', () => {
      expect(isNewerVersion('1.4.0', '1.3.9')).toBe(true);
      expect(isNewerVersion('1.3.9', '1.4.0')).toBe(false);
    });

    it('should detect newer patch version', () => {
      expect(isNewerVersion('1.3.10', '1.3.9')).toBe(true);
      expect(isNewerVersion('1.3.9', '1.3.10')).toBe(false);
    });

    it('should return false for same version', () => {
      expect(isNewerVersion('1.3.9', '1.3.9')).toBe(false);
    });
  });

  describe('beta to beta', () => {
    it('should detect newer beta of same base', () => {
      expect(isNewerVersion('1.3.9-beta.2', '1.3.9-beta.1')).toBe(true);
      expect(isNewerVersion('1.3.9-beta.1', '1.3.9-beta.2')).toBe(false);
    });

    it('should handle double-digit beta numbers', () => {
      expect(isNewerVersion('1.3.9-beta.10', '1.3.9-beta.9')).toBe(true);
      expect(isNewerVersion('1.3.9-beta.9', '1.3.9-beta.10')).toBe(false);
    });

    it('should return false for same beta', () => {
      expect(isNewerVersion('1.3.9-beta.3', '1.3.9-beta.3')).toBe(false);
    });
  });

  describe('beta to stable transitions', () => {
    it('should detect stable release of same base as newer', () => {
      // User on 1.3.9-beta.4, stable 1.3.9 released
      expect(isNewerVersion('1.3.9', '1.3.9-beta.4')).toBe(true);
      expect(isNewerVersion('1.3.9', '1.3.9-beta.99')).toBe(true);
    });

    it('should not consider beta newer than same stable', () => {
      expect(isNewerVersion('1.3.9-beta.4', '1.3.9')).toBe(false);
    });
  });

  describe('cross-version comparisons', () => {
    it('should detect higher version beta as newer than lower stable', () => {
      // User on 1.3.9 stable, 1.4.0-beta.1 released (but they are on stable channel)
      // This would only show if they explicitly opt into beta
      expect(isNewerVersion('1.4.0-beta.1', '1.3.9')).toBe(true);
    });

    it('should not show lower stable as update to higher beta', () => {
      // User on 1.4.0-beta.3, latest stable is 1.3.9
      // Should NOT show 1.3.9 as an update (they are already ahead)
      expect(isNewerVersion('1.3.9', '1.4.0-beta.3')).toBe(false);
    });

    it('should show same-line stable as update to beta', () => {
      // User on 1.4.0-beta.3, stable 1.4.0 released
      expect(isNewerVersion('1.4.0', '1.4.0-beta.3')).toBe(true);
    });
  });

  describe('real-world scenarios', () => {
    it('scenario: beta.1 user sees beta.2', () => {
      expect(isNewerVersion('v1.3.9-beta.2', 'v1.3.9-beta.1')).toBe(true);
    });

    it('scenario: beta.4 user sees stable 1.3.9', () => {
      expect(isNewerVersion('v1.3.9', 'v1.3.9-beta.4')).toBe(true);
    });

    it('scenario: 1.4.0-beta.3 user sees 1.4.0 stable', () => {
      expect(isNewerVersion('v1.4.0', 'v1.4.0-beta.3')).toBe(true);
    });

    it('scenario: 1.4.0-beta.3 user sees 1.4.0-beta.4', () => {
      expect(isNewerVersion('v1.4.0-beta.4', 'v1.4.0-beta.3')).toBe(true);
    });

    it('scenario: stable 1.3.9 user does not see 1.4.0-beta.1 (stable channel)', () => {
      // This is handled by the fetch logic, not version comparison
      // But if compared directly, beta IS newer
      expect(isNewerVersion('v1.4.0-beta.1', 'v1.3.9')).toBe(true);
    });
  });
});
