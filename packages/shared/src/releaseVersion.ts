export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  prereleaseNum: number | null;
  isPrerelease: boolean;
}

const PRERELEASE_PATTERN = /-(alpha|beta|rc|next|dev|canary)\.?\d*$/i;

/** Build info and tags carry a leading v (prod reports "v2.3.0-beta.5"); notes files don't. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, '');
}

/**
 * Parse a semantic version string into components
 * Handles: 1.3.9, v1.3.9, 1.3.9-beta.3, v1.4.0-rc.1
 */
export function parseVersion(version: string): ParsedVersion {
  const v = normalizeVersion(version);
  const match = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z]+)(?:\.(\d+))?)?$/);

  if (!match) {
    return {
      major: 0,
      minor: 0,
      patch: 0,
      prerelease: null,
      prereleaseNum: null,
      isPrerelease: false,
    };
  }

  const [, major = '0', minor = '0', patch = '0', prerelease, prereleaseNum] = match;

  return {
    major: parseInt(major, 10),
    minor: parseInt(minor, 10),
    patch: parseInt(patch, 10),
    prerelease: prerelease ?? null,
    prereleaseNum: prereleaseNum ? parseInt(prereleaseNum, 10) : null,
    isPrerelease: !!prerelease,
  };
}

export function isPrerelease(version: string): boolean {
  return PRERELEASE_PATTERN.test(normalizeVersion(version));
}

/** "1.3.9-beta.3" -> "1.3.9" */
export function getBaseVersion(version: string): string {
  return normalizeVersion(version).replace(/-.*$/, '');
}

/**
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 * A stable release sorts above any prerelease of the same base (1.3.9 > 1.3.9-beta.99);
 * prereleases order dev < canary < alpha < beta < rc < next, then by number.
 */
export function compareVersions(a: string, b: string): number {
  const vA = parseVersion(a);
  const vB = parseVersion(b);

  if (vA.major !== vB.major) return vA.major > vB.major ? 1 : -1;
  if (vA.minor !== vB.minor) return vA.minor > vB.minor ? 1 : -1;
  if (vA.patch !== vB.patch) return vA.patch > vB.patch ? 1 : -1;

  if (!vA.isPrerelease && !vB.isPrerelease) return 0;
  if (!vA.isPrerelease && vB.isPrerelease) return 1;
  if (vA.isPrerelease && !vB.isPrerelease) return -1;

  const prereleaseOrder: Record<string, number> = {
    dev: 0,
    canary: 1,
    alpha: 2,
    beta: 3,
    rc: 4,
    next: 5,
  };

  const orderA = prereleaseOrder[vA.prerelease?.toLowerCase() ?? ''] ?? 3;
  const orderB = prereleaseOrder[vB.prerelease?.toLowerCase() ?? ''] ?? 3;
  if (orderA !== orderB) return orderA > orderB ? 1 : -1;

  const numA = vA.prereleaseNum ?? 0;
  const numB = vB.prereleaseNum ?? 0;
  if (numA !== numB) return numA > numB ? 1 : -1;

  return 0;
}

export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}
