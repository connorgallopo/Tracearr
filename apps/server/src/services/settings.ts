/**
 * Settings service - Key-value settings abstraction layer
 *
 * All settings access should go through this module instead of querying
 * the settings table directly.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import {
  SESSION_LIMITS,
  type Settings,
  type BackupScheduleType,
  type EmailBrandingSettings,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';

/** Default values for public settings (returned by GET /settings). */
const PUBLIC_DEFAULTS: Settings = {
  // Settings interface fields
  allowGuestAccess: false,
  unitSystem: 'metric',
  pollerEnabled: true,
  pollerIntervalMs: 15000,
  usePlexGeoip: false,
  tautulliUrl: null,
  tautulliApiKey: null,
  externalUrl: null,
  trustProxy: false,
  mobileEnabled: false,
  tailscaleEnabled: false,
  tailscaleHostname: null,
  // Backup settings
  backupScheduleType: 'disabled',
  backupScheduleTime: '02:00',
  backupScheduleDayOfWeek: 0,
  backupScheduleDayOfMonth: 1,
  backupRetentionCount: 7,
  pluginUpdateCheckEnabled: true,
  pluginManifestUrl: null,
  serverUpdateCheckEnabled: true,
  // Watch completion thresholds default to the shared industry-standard constant
  watchedThresholdMovie: Math.round(SESSION_LIMITS.WATCH_COMPLETION_THRESHOLD * 100),
  watchedThresholdTv: Math.round(SESSION_LIMITS.WATCH_COMPLETION_THRESHOLD * 100),
  watchedThresholdMusic: Math.round(SESSION_LIMITS.WATCH_COMPLETION_THRESHOLD * 100),
  publicApiRateLimitPerMinute: 240,
  imagePrecacheEnabled: true,
  preferredPosterServerId: null,
};

export interface ImportedHistoryLinkState {
  /** 'done' stops the automatic run after Plex library syncs until something re-arms it */
  state: 'pending' | 'done';
  /** Servers whose provider-id pass has finished since the last re-arm */
  providerPassDoneServers: string[];
  autoAttempts: number;
  /** Bumped by every re-arm, so a link job that read an older one cannot write over it */
  generation: number;
  /** ISO time of the last re-arm; automatic runs stop a fixed time after it */
  armedAt: string;
}

/**
 * Internal-only settings, not exposed in the public Settings API.
 * Add new internal keys here; types, defaults, and filtering are all derived.
 */
const INTERNAL_DEFAULTS = {
  tailscaleState: null as string | null,
  jwtRevokedBefore: null as string | null, // ISO 8601 — tokens issued before this timestamp are rejected
  localLoginEnabled: true,
  // ISO 8601 - set once when the last legacy:1 version sentinel clears; marks
  // where storage history changes meaning (multi-version rollups)
  mediaVersionsBackfilledAt: null as string | null,
  // ISO 8601 - set once when pre-changeover snapshot history has been
  // regenerated in multi-version semantics; retires the growth fit clamp
  snapshotsNormalizedAt: null as string | null,
  // Per-install Plex client identifier, generated on first boot. Scopes plex.tv
  // PINs to this deployment. Served to the web UI, so it is public, not secret.
  plexClientIdentifier: null as string | null,
  // The owner's email branding block, validated by emailBrandingSchema on read and write.
  emailBranding: null as EmailBrandingSettings | null,
  // Normalized version the owner last dismissed the what's-new dialog on; 'legacy' marks an
  // install that predates the dialog. Seeded once at boot, so null only before first boot.
  whatsNewLastSeenVersion: null as string | null,
  // Re-armed by saving Tautulli settings, completing a Tautulli import and adding a Plex server.
  importedHistoryLink: {
    state: 'pending',
    providerPassDoneServers: [],
    autoAttempts: 0,
    generation: 0,
  } as Omit<ImportedHistoryLinkState, 'armedAt'> & { armedAt?: string },
};

type InternalSettings = typeof INTERNAL_DEFAULTS;

/** All settings: public + internal */
type SettingTypes = Settings & InternalSettings;
type SettingKey = keyof SettingTypes;

/** Combined defaults — single source of truth. When a key doesn't exist in the DB, these defaults are used. */
const ALL_DEFAULTS: SettingTypes = { ...PUBLIC_DEFAULTS, ...INTERNAL_DEFAULTS };

// TTL fallback for multi-instance deployments: another instance's write-through update isn't visible here, so a setting change can take up to this long to apply.
const SETTINGS_CACHE_TTL_MS = 10_000;

const settingsCache = new Map<SettingKey, { value: unknown; expiresAt: number }>();

function cacheSetting<K extends SettingKey>(key: K, value: SettingTypes[K]): void {
  settingsCache.set(key, { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
}

/** Clear the in-process settings cache. Used by the factory-reset debug route. */
export function resetSettingsCache(): void {
  settingsCache.clear();
}

/** Get a single setting value. Returns the stored value or the default. */
export async function getSetting<K extends SettingKey>(key: K): Promise<SettingTypes[K]> {
  const cached = settingsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as SettingTypes[K];
  }

  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.name, key))
    .limit(1);

  const value = rows.length === 0 ? ALL_DEFAULTS[key] : (rows[0]!.value as SettingTypes[K]);
  cacheSetting(key, value);
  return value;
}

/** Get multiple settings by keys. Returns a Record with defaults applied for missing keys. */
export async function getSettings<K extends SettingKey>(keys: K[]): Promise<Pick<SettingTypes, K>> {
  if (keys.length === 0) return {} as Pick<SettingTypes, K>;

  const result = {} as Record<K, unknown>;
  const misses: K[] = [];
  const now = Date.now();

  for (const key of keys) {
    const cached = settingsCache.get(key);
    if (cached && cached.expiresAt > now) {
      result[key] = cached.value;
    } else {
      misses.push(key);
    }
  }

  if (misses.length > 0) {
    const rows = await db
      .select({ name: settings.name, value: settings.value })
      .from(settings)
      .where(inArray(settings.name, misses));

    const found = new Map(rows.map((r) => [r.name, r.value]));

    for (const key of misses) {
      const value = found.has(key) ? found.get(key) : ALL_DEFAULTS[key];
      result[key] = value;
      cacheSetting(key, value as SettingTypes[K]);
    }
  }

  return result as Pick<SettingTypes, K>;
}

/** All keys that make up the public Settings object. */
const PUBLIC_KEYS = Object.keys(PUBLIC_DEFAULTS) as (keyof Settings)[];

/** Get ALL settings as a typed Settings object (used by GET /settings). */
export async function getAllSettings(): Promise<Settings> {
  return getSettings(PUBLIC_KEYS);
}

/** Upsert one or more settings. */
export async function setSettings(updates: Partial<SettingTypes>): Promise<void> {
  const entries = Object.entries(updates);
  if (entries.length === 0) return;

  // Single atomic multi-row upsert: one statement acquires and releases its row
  // locks in one shot, instead of a transaction that holds locks on each key
  // across a round-trip per key until commit.
  await db
    .insert(settings)
    .values(entries.map(([name, value]) => ({ name, value })))
    .onConflictDoUpdate({
      target: settings.name,
      set: { value: sql`excluded.value` },
    });

  for (const [name, value] of entries) {
    cacheSetting(name as SettingKey, value);
  }
}

/** Set a single setting. */
export async function setSetting<K extends SettingKey>(
  key: K,
  value: SettingTypes[K]
): Promise<void> {
  await db.insert(settings).values({ name: key, value }).onConflictDoUpdate({
    target: settings.name,
    set: { value },
  });
  cacheSetting(key, value);
}

const LINK_GENERATION = sql`COALESCE((${settings.value}->>'generation')::int, 0)`;

/**
 * The link state with defaults filled in, so a row written before `generation`
 * existed reads as 0 and one written before `armedAt` existed reads as armed now.
 */
export async function getImportedHistoryLinkState(): Promise<ImportedHistoryLinkState> {
  return {
    ...INTERNAL_DEFAULTS.importedHistoryLink,
    armedAt: new Date().toISOString(),
    ...(await getSetting('importedHistoryLink')),
  };
}

/** Re-arm imported history linking and bump its generation in one statement. */
export async function rearmImportedHistoryLink(options: {
  keepProviderPass: boolean;
}): Promise<void> {
  const armedAt = new Date().toISOString();
  const reset: Partial<ImportedHistoryLinkState> = { state: 'pending', autoAttempts: 0, armedAt };
  if (!options.keepProviderPass) reset.providerPassDoneServers = [];
  const [row] = await db
    .insert(settings)
    .values({
      name: 'importedHistoryLink',
      value: { ...INTERNAL_DEFAULTS.importedHistoryLink, generation: 1, armedAt },
    })
    .onConflictDoUpdate({
      target: settings.name,
      set: {
        value: sql`${settings.value} || ${JSON.stringify(reset)}::jsonb || jsonb_build_object('generation', ${LINK_GENERATION} + 1)`,
      },
    })
    .returning({ value: settings.value });
  if (row) cacheSetting('importedHistoryLink', row.value as ImportedHistoryLinkState);
}

/** Write the link state only while the stored generation is still `generation`. */
export async function setImportedHistoryLinkState(
  generation: number,
  value: ImportedHistoryLinkState
): Promise<boolean> {
  const rows = await db
    .insert(settings)
    .values({ name: 'importedHistoryLink', value })
    .onConflictDoUpdate({
      target: settings.name,
      set: { value },
      setWhere: sql`${LINK_GENERATION} = ${generation}`,
    })
    .returning({ value: settings.value });
  if (rows.length === 0) {
    settingsCache.delete('importedHistoryLink');
    return false;
  }
  cacheSetting('importedHistoryLink', value);
  return true;
}

// ============================================================================
// Typed getter functions (used by internal consumers)
// ============================================================================

export async function getPollerSettings(): Promise<{
  enabled: boolean;
  intervalMs: number;
}> {
  const s = await getSettings(['pollerEnabled', 'pollerIntervalMs']);
  return {
    enabled: s.pollerEnabled,
    intervalMs: s.pollerIntervalMs,
  };
}

export async function getGeoIPSettings(): Promise<{ usePlexGeoip: boolean }> {
  return { usePlexGeoip: await getSetting('usePlexGeoip') };
}

/** Resolve the watch-completion threshold (0-1 fraction) for a given media type. */
export async function getWatchedThreshold(mediaType: string): Promise<number> {
  const key =
    mediaType === 'episode'
      ? 'watchedThresholdTv'
      : mediaType === 'track'
        ? 'watchedThresholdMusic'
        : 'watchedThresholdMovie';
  const pct = await getSetting(key);
  return Math.min(100, Math.max(1, pct)) / 100;
}

export interface WatchedThresholds {
  movie: number;
  episode: number;
  track: number;
}

export async function getWatchedThresholds(): Promise<WatchedThresholds> {
  return {
    movie: await getWatchedThreshold('movie'),
    episode: await getWatchedThreshold('episode'),
    track: await getWatchedThreshold('track'),
  };
}

export function watchedThresholdFor(thresholds: WatchedThresholds, mediaType: string): number {
  return mediaType === 'episode'
    ? thresholds.episode
    : mediaType === 'track'
      ? thresholds.track
      : thresholds.movie;
}

export async function getNetworkSettings(): Promise<{
  externalUrl: string | null;
  trustProxy: boolean;
}> {
  const s = await getSettings(['externalUrl', 'trustProxy']);
  return {
    externalUrl: s.externalUrl,
    trustProxy: s.trustProxy,
  };
}

export async function getBackupScheduleSettings(): Promise<{
  type: BackupScheduleType;
  time: string;
  dayOfWeek: number;
  dayOfMonth: number;
  retentionCount: number;
}> {
  const s = await getSettings([
    'backupScheduleType',
    'backupScheduleTime',
    'backupScheduleDayOfWeek',
    'backupScheduleDayOfMonth',
    'backupRetentionCount',
  ]);
  return {
    type: s.backupScheduleType,
    time: s.backupScheduleTime,
    dayOfWeek: s.backupScheduleDayOfWeek,
    dayOfMonth: s.backupScheduleDayOfMonth,
    retentionCount: s.backupRetentionCount,
  };
}
