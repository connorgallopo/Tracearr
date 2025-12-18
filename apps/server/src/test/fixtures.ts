/**
 * Test fixtures and factory functions for creating test data
 */

import type {
  Session,
  Rule,
  User,
  ServerUser,
  Violation,
  RuleType,
  RuleParams,
  SessionState,
  MediaType,
  ViolationSeverity,
  ImpossibleTravelParams,
  SimultaneousLocationsParams,
  DeviceVelocityParams,
  ConcurrentStreamsParams,
  GeoRestrictionParams,
  AuthUser,
  UserRole,
} from '@tracearr/shared';
import { RULE_DEFAULTS } from '@tracearr/shared';
import { randomUUID } from 'node:crypto';

/**
 * Create a mock session with sensible defaults
 */
export function createMockSession(overrides: Partial<Session> = {}): Session {
  const id = overrides.id ?? randomUUID();
  const serverUserId = overrides.serverUserId ?? randomUUID();
  const serverId = overrides.serverId ?? randomUUID();

  return {
    id,
    serverId,
    serverUserId,
    sessionKey: `session_${Date.now()}_${id.slice(0, 8)}`,
    state: 'playing' as SessionState,
    mediaType: 'movie' as MediaType,
    mediaTitle: 'Test Movie',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2024,
    thumbPath: null,
    ratingKey: null,
    externalSessionId: null,
    startedAt: new Date(),
    stoppedAt: null,
    durationMs: null,
    totalDurationMs: 7200000,
    progressMs: 0,
    // Pause tracking
    lastPausedAt: null,
    pausedDurationMs: 0,
    referenceId: null,
    watched: false,
    // Network/device info
    ipAddress: '192.168.1.1',
    geoCity: 'New York',
    geoRegion: 'New York',
    geoCountry: 'US',
    geoLat: 40.7128,
    geoLon: -74.006,
    playerName: 'Test Player',
    deviceId: `device_${id.slice(0, 8)}`,
    product: 'Plex Web',
    device: 'Chrome',
    platform: 'Windows',
    quality: '1080p',
    isTranscode: false,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    bitrate: 10000,
    ...overrides,
  };
}

/**
 * Create a mock rule with type-specific default params
 */
export function createMockRule<T extends RuleType>(type: T, overrides: Partial<Rule> = {}): Rule {
  return {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? `Test ${type.replace(/_/g, ' ')} Rule`,
    type,
    params: overrides.params ?? (JSON.parse(JSON.stringify(RULE_DEFAULTS[type])) as RuleParams),
    serverUserId: overrides.serverUserId ?? null, // Global rule by default
    isActive: overrides.isActive ?? true,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

/**
 * Create a mock user (identity layer)
 */
export function createMockUser(overrides: Partial<User> & { role?: UserRole } = {}): User {
  const id = overrides.id ?? randomUUID();

  return {
    id,
    username: overrides.username ?? `testuser_${id.slice(0, 8)}`,
    name: overrides.name ?? null,
    thumbnail: overrides.thumbnail ?? null,
    email: overrides.email ?? null,
    role: overrides.role ?? 'member',
    aggregateTrustScore: overrides.aggregateTrustScore ?? 100,
    totalViolations: overrides.totalViolations ?? 0,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

/**
 * Create a mock server user (account on a specific media server)
 */
export function createMockServerUser(overrides: Partial<ServerUser> = {}): ServerUser {
  const id = overrides.id ?? randomUUID();

  return {
    id,
    userId: overrides.userId ?? randomUUID(),
    serverId: overrides.serverId ?? randomUUID(),
    externalId: overrides.externalId ?? `ext_${id.slice(0, 8)}`,
    username: overrides.username ?? `serveruser_${id.slice(0, 8)}`,
    email: overrides.email ?? null,
    thumbUrl: overrides.thumbUrl ?? null,
    isServerAdmin: overrides.isServerAdmin ?? false,
    trustScore: overrides.trustScore ?? 100,
    sessionCount: overrides.sessionCount ?? 0,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

/**
 * Create a mock violation
 */
export function createMockViolation(overrides: Partial<Violation> = {}): Violation {
  return {
    id: overrides.id ?? randomUUID(),
    ruleId: overrides.ruleId ?? randomUUID(),
    serverUserId: overrides.serverUserId ?? randomUUID(),
    sessionId: overrides.sessionId ?? randomUUID(),
    severity: overrides.severity ?? ('warning' as ViolationSeverity),
    data: overrides.data ?? {},
    createdAt: overrides.createdAt ?? new Date(),
    acknowledgedAt: overrides.acknowledgedAt ?? null,
  };
}

/**
 * Create a mock auth user for request authentication
 */
export function createMockAuthUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: overrides.userId ?? randomUUID(),
    username: overrides.username ?? 'testuser',
    role: overrides.role ?? 'owner',
    serverIds: overrides.serverIds ?? [randomUUID()],
  };
}

/**
 * Create impossible travel rule params
 */
export function createImpossibleTravelParams(
  overrides: Partial<ImpossibleTravelParams> = {}
): ImpossibleTravelParams {
  return {
    maxSpeedKmh: overrides.maxSpeedKmh ?? 500,
    ignoreVpnRanges: overrides.ignoreVpnRanges ?? false,
  };
}

/**
 * Create simultaneous locations rule params
 */
export function createSimultaneousLocationsParams(
  overrides: Partial<SimultaneousLocationsParams> = {}
): SimultaneousLocationsParams {
  return {
    minDistanceKm: overrides.minDistanceKm ?? 100,
  };
}

/**
 * Create device velocity rule params
 */
export function createDeviceVelocityParams(
  overrides: Partial<DeviceVelocityParams> = {}
): DeviceVelocityParams {
  return {
    maxIps: overrides.maxIps ?? 5,
    windowHours: overrides.windowHours ?? 24,
  };
}

/**
 * Create concurrent streams rule params
 */
export function createConcurrentStreamsParams(
  overrides: Partial<ConcurrentStreamsParams> = {}
): ConcurrentStreamsParams {
  return {
    maxStreams: overrides.maxStreams ?? 3,
  };
}

/**
 * Create geo restriction rule params
 */
export function createGeoRestrictionParams(
  overrides: Partial<GeoRestrictionParams> = {}
): GeoRestrictionParams {
  return {
    mode: overrides.mode ?? 'blocklist',
    countries: overrides.countries ?? [],
  };
}

/**
 * Geographic coordinates for common test locations
 */
export const TEST_LOCATIONS = {
  newYork: { lat: 40.7128, lon: -74.006, city: 'New York', region: 'New York', country: 'US' },
  losAngeles: {
    lat: 34.0522,
    lon: -118.2437,
    city: 'Los Angeles',
    region: 'California',
    country: 'US',
  },
  london: { lat: 51.5074, lon: -0.1278, city: 'London', region: 'England', country: 'GB' },
  tokyo: { lat: 35.6762, lon: 139.6503, city: 'Tokyo', region: 'Tokyo', country: 'JP' },
  sydney: {
    lat: -33.8688,
    lon: 151.2093,
    city: 'Sydney',
    region: 'New South Wales',
    country: 'AU',
  },
  paris: { lat: 48.8566, lon: 2.3522, city: 'Paris', region: 'Île-de-France', country: 'FR' },
  berlin: { lat: 52.52, lon: 13.405, city: 'Berlin', region: 'Berlin', country: 'DE' },
  moscow: { lat: 55.7558, lon: 37.6173, city: 'Moscow', region: 'Moscow', country: 'RU' },
} as const;

/**
 * Calculate approximate distance between two locations in km
 * (Haversine formula - same as RuleEngine)
 */
export function calculateDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Create a session that started N hours ago
 */
export function createSessionHoursAgo(hoursAgo: number, overrides: Partial<Session> = {}): Session {
  const startedAt = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  return createMockSession({ startedAt, ...overrides });
}

/**
 * Create multiple sessions for the same server user with different IPs
 */
export function createSessionsWithDifferentIps(
  serverUserId: string,
  count: number,
  hoursSpread: number = 24
): Session[] {
  const sessions: Session[] = [];
  const baseTime = Date.now();

  for (let i = 0; i < count; i++) {
    const hoursAgo = (hoursSpread / count) * i;
    sessions.push(
      createMockSession({
        serverUserId,
        ipAddress: `192.168.1.${100 + i}`,
        startedAt: new Date(baseTime - hoursAgo * 60 * 60 * 1000),
      })
    );
  }

  return sessions;
}
