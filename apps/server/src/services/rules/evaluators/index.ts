import type {
  Condition,
  ConditionField,
  DeviceType,
  Platform,
  Session,
  TranscodingConditionValue,
  VideoResolution,
} from '@tracearr/shared';
import { isIpInCidr, toNetworkKey } from '../../../utils/ip.js';
import { normalizeResolution } from '../../../utils/resolutionNormalizer.js';
import { geoipService } from '../../geoip.js';
import { compare } from '../comparisons.js';
import type { ConditionEvaluator, EvaluationContext, EvaluatorResult } from '../types.js';

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
 *
 * The rule condition vocabulary (VideoResolution) tops out at "4K"; the
 * shared classifier can now also return "1440p"/"8K", so fold those into
 * "4K" here rather than widening the rule-facing enum.
 */
function getResolution(width: number | null, height: number | null): VideoResolution {
  const result = normalizeResolution({ width: width ?? undefined, height: height ?? undefined });
  if (result === '1440p' || result === '8K') return '4K';
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
 * Normalize device type from session device/platform/product info.
 */
function normalizeDeviceType(
  device: string | null,
  platform: string | null,
  product?: string | null
): DeviceType {
  const haystack = `${device ?? ''} ${platform ?? ''} ${product ?? ''}`.toLowerCase();

  // tv before browser: 'chromecast' contains 'chrome', 'webos' contains 'web'
  if (
    haystack.includes('tv') ||
    haystack.includes('roku') ||
    haystack.includes('webos') ||
    haystack.includes('tizen') ||
    haystack.includes('firetv') ||
    haystack.includes('chromecast') ||
    haystack.includes('androidtv')
  ) {
    return 'tv';
  }

  // tablet before mobile: ipad reports platform 'iOS'
  if (haystack.includes('ipad') || haystack.includes('tablet')) {
    return 'tablet';
  }

  if (
    haystack.includes('iphone') ||
    haystack.includes('phone') ||
    haystack.includes('ios') ||
    haystack.includes('android')
  ) {
    return 'mobile';
  }

  // browser before desktop so plex web on a desktop OS stays browser
  if (
    haystack.includes('chrome') ||
    haystack.includes('firefox') ||
    haystack.includes('safari') ||
    haystack.includes('edge') ||
    haystack.includes('browser') ||
    haystack.includes('web')
  ) {
    return 'browser';
  }

  if (
    haystack.includes('windows') ||
    haystack.includes('macos') ||
    haystack.includes('mac os') ||
    haystack.includes('osx') ||
    haystack.includes('os x') ||
    haystack.includes('darwin') ||
    haystack.includes('linux') ||
    haystack.includes('mac')
  ) {
    return 'desktop';
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

/**
 * Build a filter predicate for sessions belonging to the same identity as
 * context.serverUser. Falls back to single server_user matching when
 * identityServerUserIds is absent, so unmerged users evaluate exactly as
 * before this identity-aware aggregation was added.
 *
 * Detection vs action split: this aggregation runs unconditionally and is
 * NOT gated by rule.enforceAcrossServers - that flag only controls whether a
 * MATCHED rule's actions (kill_stream, message_client) reach sessions beyond
 * the triggering one, in executors/index.ts. Do not add an enforceAcrossServers
 * check here; do not remove the gate there either.
 */
function belongsToIdentity(context: EvaluationContext): (s: Session) => boolean {
  const ids = context.identityServerUserIds;
  if (ids && ids.length > 0) {
    const idSet = new Set(ids);
    return (s) => idSet.has(s.serverUserId);
  }
  return (s) => s.serverUserId === context.serverUser.id;
}

// ============================================================================
// Session Behavior Evaluators
// ============================================================================

const evaluateConcurrentStreams: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session, activeSessions } = context;
  const excludeSameDevice = condition.params?.exclude_same_device ?? true;
  const excludeSameIp = condition.params?.exclude_same_ip ?? false;
  const countDeviceTypes = condition.params?.count_device_types;
  const isIdentitySession = belongsToIdentity(context);

  // Count active sessions for this user (INCLUDING current session)
  let userActiveSessions = activeSessions.filter(isIdentitySession);

  // When count_device_types is set, only count sessions from those device types.
  // Unlike the exclusions below, the triggering session is NOT exempt.
  if (countDeviceTypes?.length) {
    userActiveSessions = userActiveSessions.filter((s) =>
      countDeviceTypes.includes(normalizeDeviceType(s.device, s.platform, s.product))
    );
  }

  // When exclude_same_device is true, don't count OTHER sessions from the same device.
  // Keep the triggering session, but remove duplicates from same device.
  if (excludeSameDevice) {
    userActiveSessions = userActiveSessions.filter(
      (s) =>
        s.id === session.id || !(session.deviceId && s.deviceId && session.deviceId === s.deviceId)
    );
  }

  // When exclude_same_ip is true, only count triggering session + sessions from different IPs
  // (IPv6 compared by /64 network key).
  if (excludeSameIp) {
    const sessionKey = toNetworkKey(session.ipAddress);
    userActiveSessions = userActiveSessions.filter(
      (s) => s.id === session.id || toNetworkKey(s.ipAddress) !== sessionKey
    );
  }

  const count = userActiveSessions.length;

  const relatedSessionIds = userActiveSessions.filter((s) => s.id !== session.id).map((s) => s.id);

  return {
    matched: compare(count, condition.operator, condition.value),
    actual: count,
    relatedSessionIds,
  };
};

const evaluateActiveSessionDistanceKm: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session, activeSessions } = context;
  const excludeSameDevice = condition.params?.exclude_same_device ?? true;
  const isIdentitySession = belongsToIdentity(context);

  // Get other active sessions for this user (excluding current session by reference)
  let otherSessions = activeSessions.filter((s) => isIdentitySession(s) && s !== session);

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
  const { session, recentSessions } = context;
  const excludeSameDevice = condition.params?.exclude_same_device ?? true;
  const isIdentitySession = belongsToIdentity(context);

  // Get previous sessions for this user (excluding current session by reference)
  let previousSessions = recentSessions
    .filter((s) => isIdentitySession(s) && s !== session)
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
  const { session, recentSessions } = context;
  const windowHours = condition.params?.window_hours ?? 24;
  const isIdentitySession = belongsToIdentity(context);

  const windowMs = windowHours * 60 * 60 * 1000;
  const cutoff = new Date(new Date(session.startedAt).getTime() - windowMs);

  // Get sessions within the window for this user
  const sessionsInWindow = recentSessions.filter(
    (s) => isIdentitySession(s) && new Date(s.startedAt) >= cutoff
  );

  // Include the current session. Count by network key; keep original IPs for details.
  const ipsByNetwork = new Map<string, string>();
  const addIp = (ip: string) => {
    const key = toNetworkKey(ip);
    if (!ipsByNetwork.has(key)) ipsByNetwork.set(key, ip);
  };
  addIp(session.ipAddress);
  for (const s of sessionsInWindow) {
    addIp(s.ipAddress);
  }

  return {
    matched: compare(ipsByNetwork.size, condition.operator, condition.value),
    actual: ipsByNetwork.size,
    details: { ips: Array.from(ipsByNetwork.values()), windowHours },
  };
};

const evaluateUniqueDevicesInWindow: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session, recentSessions } = context;
  const windowHours = condition.params?.window_hours ?? 24;
  const isIdentitySession = belongsToIdentity(context);

  const windowMs = windowHours * 60 * 60 * 1000;
  const cutoff = new Date(new Date(session.startedAt).getTime() - windowMs);

  // Get sessions within the window for this user
  const sessionsInWindow = recentSessions.filter(
    (s) => isIdentitySession(s) && new Date(s.startedAt) >= cutoff
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
// Pause Duration Evaluators
// ============================================================================

/**
 * Evaluates how long the current session has been continuously paused (in minutes).
 * Returns not matched if the session is not currently paused.
 */
const evaluateCurrentPauseMinutes: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;

  // Only applies to currently paused sessions
  if (session.state !== 'paused' || !session.lastPausedAt) {
    return { matched: false, actual: 0 };
  }

  const currentPauseMs = Date.now() - new Date(session.lastPausedAt).getTime();
  const currentPauseMinutes = currentPauseMs / 60000;

  return {
    matched: compare(currentPauseMinutes, condition.operator, condition.value),
    actual: currentPauseMinutes,
  };
};

/**
 * Evaluates the total accumulated pause time across all pause/resume cycles (in minutes).
 * Includes ongoing pause time if the session is currently paused.
 */
const evaluateTotalPauseMinutes: ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;

  let totalPauseMs = session.pausedDurationMs ?? 0;

  // Add ongoing pause time if currently paused
  if (session.state === 'paused' && session.lastPausedAt) {
    totalPauseMs += Date.now() - new Date(session.lastPausedAt).getTime();
  }

  const totalPauseMinutes = totalPauseMs / 60000;

  return {
    matched: compare(totalPauseMinutes, condition.operator, condition.value),
    actual: totalPauseMinutes,
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
  const displayName = serverUser.identityName ?? serverUser.username;

  return {
    matched: compare(serverUser.id, condition.operator, condition.value),
    actual: displayName,
    details: {
      userId: serverUser.id,
    },
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

  const deviceType = normalizeDeviceType(session.device, session.platform, session.product);

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
  current_pause_minutes: evaluateCurrentPauseMinutes,
  total_pause_minutes: evaluateTotalPauseMinutes,

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
  normalizeDeviceType,
  normalizePlatform,
  resolutionToNumber,
};
