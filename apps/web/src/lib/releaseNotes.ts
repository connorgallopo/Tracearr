import {
  compareVersions,
  getBaseVersion,
  isMinorRelease,
  isPrerelease,
  parseVersion,
  releaseNotesFileSchema,
  WHATS_NEW_LEGACY,
  type ReleaseNotesFile,
} from '@tracearr/shared';

const files = import.meta.glob<unknown>('../../../../release-notes/*.json', {
  eager: true,
  import: 'default',
});

/** CI validates every file before it ships; this only keeps one bad file from blanking the app at runtime. */
export function parseReleaseNotes(files: Record<string, unknown>): ReleaseNotesFile[] {
  const notes: ReleaseNotesFile[] = [];
  for (const [path, raw] of Object.entries(files)) {
    const result = releaseNotesFileSchema.safeParse(raw);
    if (result.success) {
      notes.push(result.data);
    } else {
      console.error(`Invalid release notes file ${path}:`, result.error);
    }
  }
  return notes.sort((a, b) => compareVersions(b.version, a.version));
}

export const RELEASE_NOTES: ReleaseNotesFile[] = parseReleaseNotes(files);

export interface WhatsNewSections {
  lead: ReleaseNotesFile[];
  patches: ReleaseNotesFile[];
  since: string | null;
  earlier: ReleaseNotesFile[];
}

function sameMinor(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  return pa.major === pb.major && pa.minor === pb.minor;
}

function minorOf(version: string): string {
  const parsed = parseVersion(version);
  return `${parsed.major}.${parsed.minor}.0`;
}

function isStablePatch(version: string): boolean {
  return !isPrerelease(version) && !isMinorRelease(version);
}

function baseFileOf(notes: ReleaseNotesFile[], running: string): ReleaseNotesFile[] {
  const base = getBaseVersion(running);
  return notes.filter((n) => n.version === base);
}

export function selectAutoOpen(
  notes: ReleaseNotesFile[],
  running: string,
  lastSeen: string | null
): WhatsNewSections | null {
  if (lastSeen === null) return null;
  const legacy = lastSeen === WHATS_NEW_LEGACY;

  if (isPrerelease(running)) {
    if (running === lastSeen) return null;
    if (!legacy && compareVersions(getBaseVersion(running), getBaseVersion(lastSeen)) < 0)
      return null;
    const lead = baseFileOf(notes, running);
    return lead.length > 0 ? { lead, patches: [], since: null, earlier: [] } : null;
  }

  if (!legacy && compareVersions(running, lastSeen) <= 0) return null;
  const newerThanSeen = (version: string) => legacy || compareVersions(version, lastSeen) > 0;
  const upToRunning = (version: string) => compareVersions(version, running) <= 0;

  const lead = notes.filter(
    (n) =>
      isMinorRelease(n.version) &&
      upToRunning(n.version) &&
      (legacy ? sameMinor(n.version, running) : newerThanSeen(n.version))
  );
  if (lead.length === 0) return null;

  const patches = notes.filter(
    (n) =>
      isStablePatch(n.version) &&
      sameMinor(n.version, running) &&
      upToRunning(n.version) &&
      newerThanSeen(n.version)
  );
  return { lead, patches, since: patches.length > 0 ? minorOf(running) : null, earlier: [] };
}

export function selectReopen(notes: ReleaseNotesFile[], running: string): WhatsNewSections {
  const olderMinors = (exclude: (version: string) => boolean) =>
    notes.filter(
      (n) =>
        isMinorRelease(n.version) && compareVersions(n.version, running) < 0 && !exclude(n.version)
    );

  if (isPrerelease(running)) {
    return {
      lead: baseFileOf(notes, running),
      patches: [],
      since: null,
      earlier: olderMinors(() => false),
    };
  }

  const inRunningMinor = (version: string) =>
    sameMinor(version, running) && compareVersions(version, running) <= 0;
  const lead = notes.filter((n) => isMinorRelease(n.version) && inRunningMinor(n.version));
  const patches = notes.filter((n) => isStablePatch(n.version) && inRunningMinor(n.version));
  return {
    lead,
    patches,
    since: patches.length > 0 ? minorOf(running) : null,
    earlier: olderMinors((version) => sameMinor(version, running)),
  };
}
