import type {
  Condition,
  ConditionField,
  VideoResolution,
  DeviceType,
  Platform,
  TranscodingConditionValue,
} from '@tracearr/shared';
import type { ConditionEvaluator, EvaluationContext, EvaluatorResult } from '../types.js';
import { compare } from '../comparisons.js';
import { geoipService } from '../../geoip.js';
import { normalizeResolution } from '../../../utils/resolutionNormalizer.js';
import { db } from '../../../db/client.js';
import { sessions } from '../../../db/schema.js';
import { sql, eq, and, gte } from 'drizzle-orm';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate distance between two points using the Haversine formula.
 * @returns Distance in kilometers, or null if coordinates are missing.
 */
function calculateDistanceKm(
  lat1: number | null,
  lon1: number | null,
  lat2: number | null,
  lon2: number | null
): number | null {
  if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) {
    return null;
  }

  const EARTH_RADIUS_KM = 6371;
  const toRadians = (deg: number): number => (deg * Math.PI) / 180;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_KM * c;
}

/**
 * Get normalized resolution from dimensions using the standard normalizer.
 * Returns 'unknown' if dimensions are missing.
 */
function getResolution(width: number | null, height: number | null): VideoResolution {
  const result = normalizeResolution({ width: width ?? undefined, height: height ?? undefined });
  return (result as VideoResolution) ?? 'unknown';
}

/**
 * Convert resolution string to numeric value for comparison.
 */
function resolutionToNumber(resolution: VideoResolution): number {
  const map: Record<VideoResolution, number> = {
    '4K': 2160,
    '1080p': 1080,
    '720p': 720,
    '480p': 480,
    SD: 360,
    unknown: 0,
  };
  return map[resolution] ?? 0;
}

/**
 * Normalize device type from session device/platform info.
 */
function normalizeDeviceType(device: string | null, platform: string | null): DeviceType {
  const deviceLower = (device ?? '').toLowerCase();
  const platformLower = (platform ?? '').toLowerCase();

  // TV detection
  if (
    deviceLower.includes('tv') ||
    platformLower.includes('tv') ||
    platformLower.includes('roku') ||
    platformLower.includes('webos') ||
    platformLower.includes('tizen') ||
    platformLower.includes('firetv') ||
    platformLower.includes('chromecast') ||
    platformLower.includes('androidtv')
  ) {
    return 'tv';
  }

  // Mobile detection
  if (
    deviceLower.includes('iphone') ||
    deviceLower.includes('phone') ||
    platformLower === 'ios' ||
    platformLower === 'android'
  ) {
    // Check if it's a tablet
    if (deviceLower.includes('ipad') || deviceLower.includes('tablet')) {
      return 'tablet';
    }
    return 'mobile';
  }

  // Tablet detection
  if (deviceLower.includes('ipad') || deviceLower.includes('tablet')) {
    return 'tablet';
  }

  // Desktop detection
  if (
    platformLower.includes('windows') ||
    platformLower.includes('macos') ||
    platformLower.includes('linux')
  ) {
    return 'desktop';
  }

  // Browser detection (web players)
  if (
    deviceLower.includes('browser') ||
    deviceLower.includes('chrome') ||
    deviceLower.includes('firefox') ||
    deviceLower.includes('safari') ||
    deviceLower.includes('edge')
  ) {
    return 'browser';
  }

  return 'unknown';
}

/**
 * Normalize platform string to Platform enum value.
 */
function normalizePlatform(platform: string | null): Platform {
  if (!platform) return 'unknown';

  const lower = platform.toLowerCase();

  if (lower.includes('ios') || lower === 'iphone' || lower === 'ipad') return 'ios';
  if (lower.includes('android')) {
    if (lower.includes('tv')) return 'androidtv';
    return 'android';
  }
  if (lower.includes('windows')) return 'windows';
  if (lower.includes('macos') || lower.includes('mac os') || lower === 'darwin') return 'macos';
  if (lower.includes('linux')) return 'linux';
  if (lower.includes('tvos') || lower.includes('apple tv')) return 'tvos';
  if (lower.includes('roku')) return 'roku';
  if (lower.includes('webos')) return 'webos';
  if (lower.includes('tizen')) return 'tizen';

  return 'unknown';
}

// ============================================================================
// Session Behavior Evaluators
// ============================================================================

const evaluateConcurrentStreams: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session, activeSessions, serverUser } = context;
  const excludeSameDevice = condition.params?.exclude_same_device ?? false;

  // Count active sessions for this user (excluding current session by reference to avoid double-count)
  let userActiveSessions = activeSessions.filter(
    (s) => s.serverUserId === serverUser.id && s !== session
  );

  // When exclude_same_device is true, don't count sessions from the same device.
  // A single physical device can only play one stream - duplicates are stale data.
  if (excludeSameDevice) {
    userActiveSessions = userActiveSessions.filter(
      (s) => !(session.deviceId && s.deviceId && session.deviceId === s.deviceId)
    );
  }

  // Add 1 for the current session
  const count = userActiveSessions.length + 1;

  return {
    matched: compare(count, condition.operator, condition.value),
    actual: count,
    relatedSessionIds: userActiveSessions.map((s) => s.id),
  };
};

const evaluateActiveSessionDistanceKm: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session, activeSessions, serverUser } = context;
  const excludeSameDevice = condition.params?.exclude_same_device ?? false;

  // Get other active sessions for this user (excluding current session by reference)
  let otherSessions = activeSessions.filter(
    (s) => s.serverUserId === serverUser.id && s !== session
  );

  // When exclude_same_device is true, only consider sessions from different devices.
  // Same device = same physical location, so distance comparison doesn't make sense.
  if (excludeSameDevice) {
    otherSessions = otherSessions.filter(
      (s) => !(session.deviceId && s.deviceId && session.deviceId === s.deviceId)
    );
  }

  if (otherSessions.length === 0) {
    return {
      matched: compare(0, condition.operator, condition.value),
      actual: 0,
      relatedSessionIds: [],
    };
  }

  // Calculate max distance from current session to any other active session
  let maxDistance = 0;
  const distances: Record<string, number> = {};
  for (const other of otherSessions) {
    const distance = calculateDistanceKm(
      session.geoLat,
      session.geoLon,
      other.geoLat,
      other.geoLon
    );
    if (distance !== null) {
      distances[other.id] = Math.round(distance * 100) / 100;
      if (distance > maxDistance) {
        maxDistance = distance;
      }
    }
  }

  return {
    matched: compare(maxDistance, condition.operator, condition.value),
    actual: Math.round(maxDistance * 100) / 100,
    relatedSessionIds: otherSessions.map((s) => s.id),
    details: { distances },
  };
};

const evaluateTravelSpeedKmh: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session, recentSessions, serverUser } = context;
  const excludeSameDevice = condition.params?.exclude_same_device ?? false;

  // Get previous sessions for this user (excluding current session by reference)
  let previousSessions = recentSessions
    .filter((s) => s.serverUserId === serverUser.id && s !== session)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  // When exclude_same_device is true, only compare against sessions from different devices.
  // VPN switches on the same device are not "impossible travel" - the device didn't move.
  if (excludeSameDevice) {
    previousSessions = previousSessions.filter(
      (s) => !(session.deviceId && s.deviceId && session.deviceId === s.deviceId)
    );
  }

  if (previousSessions.length === 0) {
    return {
      matched: compare(0, condition.operator, condition.value),
      actual: 0,
    };
  }

  const previous = previousSessions[0];
  if (!previous) {
    return {
      matched: compare(0, condition.operator, condition.value),
      actual: 0,
    };
  }

  const distance = calculateDistanceKm(
    session.geoLat,
    session.geoLon,
    previous.geoLat,
    previous.geoLon
  );

  if (distance === null) {
    return {
      matched: compare(0, condition.operator, condition.value),
      actual: 0,
      relatedSessionIds: [previous.id],
    };
  }

  const timeDeltaMs =
    new Date(session.startedAt).getTime() - new Date(previous.startedAt).getTime();
  const timeDeltaHours = timeDeltaMs / (1000 * 60 * 60);

  let speedKmh: number;
  if (timeDeltaHours <= 0) {
    // If sessions are at the same time with distance, speed is effectively infinite
    speedKmh = distance > 0 ? Infinity : 0;
  } else {
    speedKmh = distance / timeDeltaHours;
  }

  return {
    matched: compare(speedKmh, condition.operator, condition.value),
    actual: Math.round(speedKmh * 100) / 100,
    relatedSessionIds: [previous.id],
    details: {
      distance: Math.round(distance * 100) / 100,
      timeDeltaHours: Math.round(timeDeltaHours * 100) / 100,
      previousLocation: {
        lat: previous.geoLat,
        lon: previous.geoLon,
        city: previous.geoCity,
        country: previous.geoCountry,
      },
      currentLocation: {
        lat: session.geoLat,
        lon: session.geoLon,
        city: session.geoCity,
        country: session.geoCountry,
      },
    },
  };
};

const evaluateUniqueIpsInWindow: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session, recentSessions, serverUser } = context;
  const windowHours = condition.params?.window_hours ?? 24;

  const windowMs = windowHours * 60 * 60 * 1000;
  const cutoff = new Date(new Date(session.startedAt).getTime() - windowMs);

  // Get sessions within the window for this user
  const sessionsInWindow = recentSessions.filter(
    (s) => s.serverUserId === serverUser.id && new Date(s.startedAt) >= cutoff
  );

  // Include the current session
  const allIps = new Set<string>();
  allIps.add(session.ipAddress);

  for (const s of sessionsInWindow) {
    allIps.add(s.ipAddress);
  }

  return {
    matched: compare(allIps.size, condition.operator, condition.value),
    actual: allIps.size,
    details: { ips: Array.from(allIps), windowHours },
  };
};

const evaluateUniqueDevicesInWindow: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session, recentSessions, serverUser } = context;
  const windowHours = condition.params?.window_hours ?? 24;

  const windowMs = windowHours * 60 * 60 * 1000;
  const cutoff = new Date(new Date(session.startedAt).getTime() - windowMs);

  // Get sessions within the window for this user
  const sessionsInWindow = recentSessions.filter(
    (s) => s.serverUserId === serverUser.id && new Date(s.startedAt) >= cutoff
  );

  // Count unique devices (by deviceId, falling back to playerName)
  const devices = new Set<string>();
  const addDevice = (deviceId: string | null, playerName: string | null) => {
    const identifier = deviceId ?? playerName ?? 'unknown';
    devices.add(identifier);
  };

  addDevice(session.deviceId, session.playerName);
  for (const s of sessionsInWindow) {
    addDevice(s.deviceId, s.playerName);
  }

  return {
    matched: compare(devices.size, condition.operator, condition.value),
    actual: devices.size,
    details: { devices: Array.from(devices), windowHours },
  };
};

const evaluateInactiveDays: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { serverUser } = context;

  let inactiveDays: number;
  if (!serverUser.lastActivityAt) {
    // Never had activity - treat as maximum inactivity
    inactiveDays = Math.floor(
      (Date.now() - new Date(serverUser.createdAt).getTime()) / (1000 * 60 * 60 * 24)
    );
  } else {
    inactiveDays = Math.floor(
      (Date.now() - new Date(serverUser.lastActivityAt).getTime()) / (1000 * 60 * 60 * 24)
    );
  }

  return {
    matched: compare(inactiveDays, condition.operator, condition.value),
    actual: inactiveDays,
    details: { lastActivityAt: serverUser.lastActivityAt },
  };
};

// ============================================================================
// Stream Quality Evaluators
// ============================================================================

const evaluateSourceResolution: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;

  const resolution = getResolution(session.sourceVideoWidth, session.sourceVideoHeight);
  const resolutionValue = resolutionToNumber(resolution);
  const targetValue =
    typeof condition.value === 'string'
      ? resolutionToNumber(condition.value as VideoResolution)
      : condition.value;

  // For 'in' and 'not_in' operators, compare strings directly
  if (condition.operator === 'in' || condition.operator === 'not_in') {
    return {
      matched: compare(resolution, condition.operator, condition.value),
      actual: resolution,
    };
  }

  return {
    matched: compare(resolutionValue, condition.operator, targetValue),
    actual: resolution,
  };
};

const evaluateOutputResolution: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;

  // Use stream video details for output resolution
  const width = session.streamVideoDetails?.width ?? null;
  const height = session.streamVideoDetails?.height ?? null;

  const resolution = getResolution(width, height);
  const resolutionValue = resolutionToNumber(resolution);
  const targetValue =
    typeof condition.value === 'string'
      ? resolutionToNumber(condition.value as VideoResolution)
      : condition.value;

  // For 'in' and 'not_in' operators, compare strings directly
  if (condition.operator === 'in' || condition.operator === 'not_in') {
    return {
      matched: compare(resolution, condition.operator, condition.value),
      actual: resolution,
    };
  }

  return {
    matched: compare(resolutionValue, condition.operator, targetValue),
    actual: resolution,
  };
};

const evaluateIsTranscoding: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;
  const value = condition.value;

  const details: Record<string, unknown> = {
    videoDecision: session.videoDecision,
    audioDecision: session.audioDecision,
  };

  // Handle new string values
  if (typeof value === 'string') {
    let matched: boolean;
    let actual: string;
    switch (value as TranscodingConditionValue) {
      case 'video':
        matched = session.videoDecision === 'transcode';
        actual = session.videoDecision ?? 'unknown';
        break;
      case 'audio':
        matched = session.audioDecision === 'transcode';
        actual = session.audioDecision ?? 'unknown';
        break;
      case 'video_or_audio':
        matched = session.isTranscode;
        actual = session.isTranscode ? 'transcoding' : 'direct';
        break;
      case 'neither':
        matched = !session.isTranscode;
        actual = session.isTranscode ? 'transcoding' : 'direct';
        break;
      default:
        matched = false;
        actual = 'unknown';
    }
    return { matched, actual, details };
  }

  // Backwards compatibility: handle boolean values
  return {
    matched: compare(session.isTranscode, condition.operator, condition.value),
    actual: session.isTranscode,
    details,
  };
};

const evaluateIsTranscodeDowngrade: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;

  if (!session.isTranscode) {
    return {
      matched: compare(false, condition.operator, condition.value),
      actual: false,
    };
  }

  // Compare source resolution to output resolution
  const sourceRes = getResolution(session.sourceVideoWidth, session.sourceVideoHeight);
  const outputWidth = session.streamVideoDetails?.width ?? null;
  const outputHeight = session.streamVideoDetails?.height ?? null;
  const outputRes = getResolution(outputWidth, outputHeight);

  const isDowngrade = resolutionToNumber(sourceRes) > resolutionToNumber(outputRes);

  return {
    matched: compare(isDowngrade, condition.operator, condition.value),
    actual: isDowngrade,
    details: { sourceResolution: sourceRes, outputResolution: outputRes },
  };
};

const evaluateSourceBitrateMbps: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;

  // Use source video details bitrate if available, otherwise fall back to session bitrate
  const bitrateBps = session.sourceVideoDetails?.bitrate ?? session.bitrate ?? 0;
  const bitrateMbps = bitrateBps / 1_000_000;

  return {
    matched: compare(bitrateMbps, condition.operator, condition.value),
    actual: Math.round(bitrateMbps * 100) / 100,
  };
};

// ============================================================================
// User Attribute Evaluators
// ============================================================================

const evaluateUserId: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { serverUser } = context;

  return {
    matched: compare(serverUser.id, condition.operator, condition.value),
    actual: serverUser.id,
  };
};

const evaluateTrustScore: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { serverUser } = context;

  return {
    matched: compare(serverUser.trustScore, condition.operator, condition.value),
    actual: serverUser.trustScore,
  };
};

const evaluateAccountAgeDays: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { serverUser } = context;

  const ageDays = Math.floor(
    (Date.now() - new Date(serverUser.createdAt).getTime()) / (1000 * 60 * 60 * 24)
  );

  return {
    matched: compare(ageDays, condition.operator, condition.value),
    actual: ageDays,
  };
};

// ============================================================================
// Device/Client Evaluators
// ============================================================================

const evaluateDeviceType: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;

  const deviceType = normalizeDeviceType(session.device, session.platform);

  return {
    matched: compare(deviceType, condition.operator, condition.value),
    actual: deviceType,
  };
};

const evaluateClientName: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;

  // Use product as client name (e.g., "Plex for iOS", "Plex Web")
  const clientName = session.product ?? session.playerName ?? '';

  return {
    matched: compare(clientName, condition.operator, condition.value),
    actual: clientName,
  };
};

const evaluatePlatform: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;

  const platform = normalizePlatform(session.platform);

  return {
    matched: compare(platform, condition.operator, condition.value),
    actual: platform,
  };
};

// ============================================================================
// Network/Location Evaluators
// ============================================================================

const evaluateIsLocalNetwork: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;

  const isLocal = geoipService.isPrivateIP(session.ipAddress);

  return {
    matched: compare(isLocal, condition.operator, condition.value),
    actual: isLocal,
  };
};

const evaluateCountry: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;

  const country = session.geoCountry ?? '';

  return {
    matched: compare(country, condition.operator, condition.value),
    actual: country,
  };
};

/**
 * Parse an IPv4 address into a 32-bit number.
 */
function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return null;
    result = (result << 8) + num;
  }
  return result >>> 0; // Convert to unsigned 32-bit
}

/**
 * Check if an IP address is within a CIDR range.
 * Supports IPv4 only. Returns false for IPv6 or invalid input.
 */
function isIpInCidr(ip: string, cidr: string): boolean {
  const ipNum = ipv4ToNumber(ip);
  if (ipNum === null) return false;

  const [rangeIp, prefixStr] = cidr.split('/');
  if (!rangeIp || !prefixStr) return false;

  const rangeNum = ipv4ToNumber(rangeIp);
  if (rangeNum === null) return false;

  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;

  // Create mask: for prefix=24, mask = 0xFFFFFF00
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;

  return (ipNum & mask) === (rangeNum & mask);
}

const evaluateIpInRange: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;
  const ip = session.ipAddress;

  if (!ip) {
    return { matched: false, actual: null };
  }

  // Handle 'in' and 'not_in' operators with array of CIDR ranges
  if (condition.operator === 'in' || condition.operator === 'not_in') {
    if (!Array.isArray(condition.value)) {
      return { matched: false, actual: ip };
    }

    const inRange = condition.value.some((cidr) => {
      if (typeof cidr !== 'string') return false;
      return isIpInCidr(ip, cidr);
    });

    const matched = condition.operator === 'in' ? inRange : !inRange;
    return { matched, actual: ip };
  }

  // Handle 'eq' operator with single CIDR range
  if (condition.operator === 'eq' && typeof condition.value === 'string') {
    return { matched: isIpInCidr(ip, condition.value), actual: ip };
  }

  // Handle 'neq' operator with single CIDR range
  if (condition.operator === 'neq' && typeof condition.value === 'string') {
    return { matched: !isIpInCidr(ip, condition.value), actual: ip };
  }

  return { matched: false, actual: ip };
};

// ============================================================================
// Scope Evaluators
// ============================================================================

const evaluateServerId: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { server } = context;

  return {
    matched: compare(server.id, condition.operator, condition.value),
    actual: server.id,
  };
};

const evaluateLibraryId: ConditionEvaluator = (
  _context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  // Note: Session type doesn't have libraryId based on the types.ts file
  // This would need to be added to the Session type or fetched separately
  // For now, this is a placeholder that always returns false
  // TODO: Add libraryId to Session type or context
  return {
    matched: compare('', condition.operator, condition.value),
    actual: '',
  };
};

const evaluateMediaType: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;

  return {
    matched: compare(session.mediaType, condition.operator, condition.value),
    actual: session.mediaType,
  };
};

// ============================================================================
// Bandwidth Usage Evaluator
// ============================================================================

const evaluateBandwidthUsageGb: ConditionEvaluator = async (
  context: EvaluationContext,
  condition: Condition
): Promise<EvaluatorResult> => {
  const { serverUser } = context;
  const windowPeriod = (condition.params as { window_period?: string })?.window_period ?? 'month';

  // Calculate the start of the rolling window
  const now = new Date();
  let windowMs: number;
  switch (windowPeriod) {
    case 'day':
      windowMs = 24 * 60 * 60 * 1000;
      break;
    case 'week':
      windowMs = 7 * 24 * 60 * 60 * 1000;
      break;
    case 'month':
      windowMs = 30 * 24 * 60 * 60 * 1000;
      break;
    case 'year':
      windowMs = 365 * 24 * 60 * 60 * 1000;
      break;
    default:
      windowMs = 30 * 24 * 60 * 60 * 1000;
  }
  const windowStart = new Date(now.getTime() - windowMs);

  // Query total bandwidth for this user in the window
  // Formula: SUM(bitrate_kbps * duration_ms) / 8 = total bytes
  const result = await db
    .select({
      totalBytes: sql<string>`COALESCE(SUM(COALESCE(${sessions.bitrate}, 0)::bigint * COALESCE(${sessions.durationMs}, 0)::bigint) / 8, 0)`,
    })
    .from(sessions)
    .where(and(eq(sessions.serverUserId, serverUser.id), gte(sessions.startedAt, windowStart)));

  const totalBytes = Number(result[0]?.totalBytes ?? 0);
  const usageGb = Math.round((totalBytes / 1e9) * 100) / 100;

  return {
    matched: compare(usageGb, condition.operator, condition.value),
    actual: usageGb,
    details: { windowPeriod, totalBytes, windowStart: windowStart.toISOString() },
  };
};

// ============================================================================
// Evaluator Registry
// ============================================================================

export const evaluatorRegistry: Record<ConditionField, ConditionEvaluator> = {
  // Session behavior
  concurrent_streams: evaluateConcurrentStreams,
  active_session_distance_km: evaluateActiveSessionDistanceKm,
  travel_speed_kmh: evaluateTravelSpeedKmh,
  unique_ips_in_window: evaluateUniqueIpsInWindow,
  unique_devices_in_window: evaluateUniqueDevicesInWindow,
  inactive_days: evaluateInactiveDays,
  bandwidth_usage_gb: evaluateBandwidthUsageGb,

  // Stream quality
  source_resolution: evaluateSourceResolution,
  output_resolution: evaluateOutputResolution,
  is_transcoding: evaluateIsTranscoding,
  is_transcode_downgrade: evaluateIsTranscodeDowngrade,
  source_bitrate_mbps: evaluateSourceBitrateMbps,

  // User attributes
  user_id: evaluateUserId,
  trust_score: evaluateTrustScore,
  account_age_days: evaluateAccountAgeDays,

  // Device/client
  device_type: evaluateDeviceType,
  client_name: evaluateClientName,
  platform: evaluatePlatform,

  // Network/location
  is_local_network: evaluateIsLocalNetwork,
  country: evaluateCountry,
  ip_in_range: evaluateIpInRange,

  // Scope
  server_id: evaluateServerId,
  library_id: evaluateLibraryId,
  media_type: evaluateMediaType,
};

// Export helper functions for testing
export {
  calculateDistanceKm,
  getResolution,
  resolutionToNumber,
  normalizeDeviceType,
  normalizePlatform,
};
