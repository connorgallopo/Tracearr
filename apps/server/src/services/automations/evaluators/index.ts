import { BYTES_PER_GB, TIME_MS, resolutionTierRank } from '@tracearr/shared';
import type {
  Condition,
  ConditionField,
  DeviceType,
  Platform,
  Session,
  TranscodingConditionValue,
  VideoResolution,
} from '@tracearr/shared';
import { isIpInCidr, toNetworkKey, unmapIpv4Mapped } from '../../../utils/ip.js';
import { automationsLogger } from '../../../utils/logger.js';
import { LOCAL_NETWORK_COUNTRY, normalizeToCountryCode } from '../../../utils/country.js';
import { normalizeResolution } from '../../../utils/resolutionNormalizer.js';
import { geoipService } from '../../geoip.js';
import { compare } from '../comparisons.js';
import type {
  AccountConditionEvaluator,
  AccountEvaluationContext,
  ConditionEvaluator,
  EvaluatorResult,
  ServerConditionEvaluator,
  ServerEvaluationContext,
  SessionEvaluationContext,
} from '../types.js';

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
  return (
    normalizeResolution({ width: width ?? undefined, height: height ?? undefined }) ?? 'unknown'
  );
}

/**
 * Convert resolution string to numeric value for comparison. Line counts, not
 * tier ranks: a numeric condition value is a height.
 */
function resolutionToNumber(resolution: VideoResolution): number {
  const map: Record<VideoResolution, number> = {
    '8K': 4320,
    '4K': 2160,
    '1440p': 1440,
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
 * Callers decide whether playerName participates: on Jellyfin/Emby it holds
 * DeviceName ("iPad", "SHIELD Android TV"), the only authoritative device
 * string those servers send (normalizeClient synthesizes device/platform
 * from the client name, so field absence cannot be used as the signal). On
 * Plex it holds the user-editable player title ("Living Room TV PC"), which
 * must not steer classification, so Plex callers pass null. The bare 'tv'
 * token is word-boundary matched against playerName because DeviceName can
 * be a hostname ("MATVEY-PC"); controlled fields keep substring matching so
 * 'tvOS' and 'Apple TV' hold.
 */
function normalizeDeviceType(
  device: string | null,
  platform: string | null,
  product?: string | null,
  playerName?: string | null
): DeviceType {
  const fieldHaystack = `${device ?? ''} ${platform ?? ''} ${product ?? ''}`.toLowerCase();
  const nameHaystack = (playerName ?? '').toLowerCase();
  const haystack = `${fieldHaystack} ${nameHaystack}`;

  // tv before browser: 'chromecast' contains 'chrome', 'webos' contains 'web'.
  // dlna: renderers announced through Emby/Jellyfin DLNA are TVs in practice.
  if (
    fieldHaystack.includes('tv') ||
    /\btv\b/.test(nameHaystack) ||
    haystack.includes('roku') ||
    haystack.includes('webos') ||
    haystack.includes('tizen') ||
    haystack.includes('firetv') ||
    haystack.includes('chromecast') ||
    haystack.includes('androidtv') ||
    haystack.includes('dlna')
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

  // 'desktop' catches Windows hostnames ('DESKTOP-ABC123'); the named clients
  // are desktop-only apps that carry no OS substring in any field.
  if (
    haystack.includes('windows') ||
    haystack.includes('macos') ||
    haystack.includes('mac os') ||
    haystack.includes('osx') ||
    haystack.includes('os x') ||
    haystack.includes('darwin') ||
    haystack.includes('linux') ||
    haystack.includes('mac') ||
    haystack.includes('desktop') ||
    haystack.includes('jellyfin media player') ||
    haystack.includes('emby theater')
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
function belongsToIdentity(context: AccountEvaluationContext): (s: Session) => boolean {
  const ids = context.identityServerUserIds;
  let matchesUser: (s: Session) => boolean;
  if (ids && ids.length > 0) {
    const idSet = new Set(ids);
    matchesUser = (s) => idSet.has(s.serverUserId);
  } else {
    matchesUser = (s) => s.serverUserId === context.serverUser.id;
  }

  // A server-scoped rule aggregates only that server's sessions. Without this
  // a Plex-scoped rule counts a merged identity's Jellyfin streams and can
  // kill the Plex stream over activity the rule was never scoped to see.
  const serverScope = context.rule.serverId;
  if (!serverScope) {
    return matchesUser;
  }
  return (s) => s.serverId === serverScope && matchesUser(s);
}

// ============================================================================
// Session Behavior Evaluators
// ============================================================================

const evaluateConcurrentStreams: ConditionEvaluator = (
  context: SessionEvaluationContext,
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
  // playerName inclusion follows the trigger server's type; counted sessions
  // from another server type in a cross-server identity are the accepted
  // imprecision here (rows carry no server type).
  if (countDeviceTypes?.length) {
    const includePlayerName = context.server.type !== 'plex';
    userActiveSessions = userActiveSessions.filter((s) =>
      countDeviceTypes.includes(
        normalizeDeviceType(
          s.device,
          s.platform,
          s.product,
          includePlayerName ? s.playerName : null
        )
      )
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
  context: SessionEvaluationContext,
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
  context: SessionEvaluationContext,
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
  context: SessionEvaluationContext,
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
  const addIp = (rawIp: string) => {
    // Unmap v4-mapped v6 first so isPrivateIP and toNetworkKey agree on the
    // same address (isPrivateIP only strips the dotted ::ffff: form itself).
    const ip = unmapIpv4Mapped(rawIp);
    // LAN addresses are one household, not evidence of sharing, so they are
    // never counted. Deliberately stricter than v1, which counted them
    // unless excludePrivateIps was explicitly set; that default is what
    // flagged single households as sharers.
    if (geoipService.isPrivateIP(ip)) return;
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
  context: SessionEvaluationContext,
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

/** Never-active accounts are infinitely inactive: gte/gt/neq match, eq/lt/lte do not; the hourly inactivity job's semantic since 860501ac. */
const evaluateInactiveDays: AccountConditionEvaluator = (
  context: AccountEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { serverUser } = context;
  if (!serverUser.lastActivityAt) {
    const op = condition.operator;
    return {
      matched: op === 'gte' || op === 'gt' || op === 'neq',
      actual: null,
      details: { lastActivityAt: null, neverActive: true },
    };
  }
  const inactiveDays = Math.floor(
    (Date.now() - new Date(serverUser.lastActivityAt).getTime()) / TIME_MS.DAY
  );
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
  context: SessionEvaluationContext,
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
  context: SessionEvaluationContext,
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
  context: SessionEvaluationContext,
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
  context: SessionEvaluationContext,
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
  context: SessionEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;
  const value = condition.value;

  const details: Record<string, unknown> = {
    videoDecision: session.videoDecision,
    audioDecision: session.audioDecision,
  };

  // Handle new string values, single or array (in/not_in accept arrays)
  if (typeof value === 'string' || Array.isArray(value)) {
    const rawValues = Array.isArray(value) ? value : [value];
    const known = rawValues.filter(
      (v): v is TranscodingConditionValue =>
        v === 'video' || v === 'audio' || v === 'video_or_audio' || v === 'neither'
    );
    // Unrecognized values never match under ANY operator, same as evaluateCountry
    const [first] = known;
    if (first === undefined) {
      return { matched: false, actual: 'unknown', details };
    }

    const matchesOne = (v: TranscodingConditionValue): boolean => {
      switch (v) {
        case 'video':
          return session.videoDecision === 'transcode';
        case 'audio':
          return session.audioDecision === 'transcode';
        case 'video_or_audio':
          return session.isTranscode;
        case 'neither':
          return !session.isTranscode;
      }
    };
    const actualFor = (v: TranscodingConditionValue): string => {
      switch (v) {
        case 'video':
          return session.videoDecision ?? 'unknown';
        case 'audio':
          return session.audioDecision ?? 'unknown';
        case 'video_or_audio':
        case 'neither':
          return session.isTranscode ? 'transcoding' : 'direct';
      }
    };

    const anyMatch = known.some(matchesOne);
    // some() computes the eq/in sense; neq/not_in invert it. Without this a
    // "not transcoding video" rule fires exactly when video IS transcoding.
    const inverted = condition.operator === 'neq' || condition.operator === 'not_in';
    const actual = Array.isArray(value)
      ? session.isTranscode
        ? 'transcoding'
        : 'direct'
      : actualFor(first);
    return { matched: inverted ? !anyMatch : anyMatch, actual, details };
  }

  // Backwards compatibility: handle boolean values
  return {
    matched: compare(session.isTranscode, condition.operator, condition.value),
    actual: session.isTranscode,
    details,
  };
};

const evaluateIsTranscodeDowngrade: ConditionEvaluator = (
  context: SessionEvaluationContext,
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
  context: SessionEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;

  // Use source video details bitrate if available, otherwise fall back to
  // session bitrate. Both are stored in kbps (see mediaServer/types.ts).
  const bitrateKbps = session.sourceVideoDetails?.bitrate ?? session.bitrate ?? 0;
  const bitrateMbps = bitrateKbps / 1000;

  return {
    matched: compare(bitrateMbps, condition.operator, condition.value),
    actual: Math.round(bitrateMbps * 100) / 100,
  };
};

// ============================================================================
// User Attribute Evaluators
// ============================================================================

const evaluateUserId: AccountConditionEvaluator = (
  context: AccountEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { serverUser } = context;
  const displayName = serverUser.identityName ?? serverUser.username;

  // Person semantics: the builder stores one representative account id per
  // person, so the condition matches when that account belongs to the same
  // identity as the triggering account. A plain id compare would let a
  // merged person's other accounts escape a rule the UI labels with the
  // person's name.
  const identityIds = new Set(context.identityServerUserIds ?? []);
  identityIds.add(serverUser.id);

  const values = Array.isArray(condition.value) ? condition.value : [condition.value];
  const anyMember = values.some((v) => typeof v === 'string' && identityIds.has(v));
  const inverted = condition.operator === 'neq' || condition.operator === 'not_in';

  return {
    matched: inverted ? !anyMember : anyMember,
    actual: displayName,
    details: {
      userId: serverUser.id,
    },
  };
};

const evaluateTrustScore: AccountConditionEvaluator = (
  context: AccountEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { serverUser } = context;

  return {
    matched: compare(serverUser.trustScore, condition.operator, condition.value),
    actual: serverUser.trustScore,
  };
};

const evaluateAccountAgeDays: AccountConditionEvaluator = (
  context: AccountEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { serverUser } = context;

  const ageDays = Math.floor((Date.now() - new Date(serverUser.createdAt).getTime()) / TIME_MS.DAY);

  return {
    matched: compare(ageDays, condition.operator, condition.value),
    actual: ageDays,
  };
};

// ============================================================================
// Device/Client Evaluators
// ============================================================================

const evaluateDeviceType: ConditionEvaluator = (
  context: SessionEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session, server } = context;

  const deviceType = normalizeDeviceType(
    session.device,
    session.platform,
    session.product,
    server.type === 'plex' ? null : session.playerName
  );

  return {
    matched: compare(deviceType, condition.operator, condition.value),
    actual: deviceType,
  };
};

const evaluateClientName: ConditionEvaluator = (
  context: SessionEvaluationContext,
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
  context: SessionEvaluationContext,
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
  context: SessionEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;

  const isLocal = geoipService.isPrivateIP(session.ipAddress);

  return {
    matched: compare(isLocal, condition.operator, condition.value),
    actual: isLocal,
  };
};

/**
 * Normalize the rule's country value(s) to ISO codes so a rule authored as
 * "Germany" still matches a session stored as "DE" and vice versa.
 */
function normalizeCountryConditionValue(value: Condition['value']): Condition['value'] {
  if (typeof value === 'string') {
    return normalizeToCountryCode(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((v) =>
      typeof v === 'string' ? (normalizeToCountryCode(v) ?? v) : v
    ) as Condition['value'];
  }
  return value;
}

const evaluateCountry: ConditionEvaluator = (
  context: SessionEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;
  const raw = session.geoCountry;

  // LAN sessions store the 'Local Network' sentinel and sessions without geo
  // data store null; neither has a meaningful country, so never match - a
  // "country neq US" rule must not fire on them regardless of operator.
  if (!raw || raw === LOCAL_NETWORK_COUNTRY) {
    if (!raw) {
      automationsLogger.debug(
        `country condition skipped: session ${session.id} has no geo data (ip: ${session.ipAddress ?? 'unknown'})`
      );
    }
    return { matched: false, actual: raw ?? null };
  }

  // geoCountry stores countryCode ?? country, so full names appear whenever
  // the geo lookup had no code; normalize both sides to ISO before comparing.
  const country = normalizeToCountryCode(raw);
  if (!country) {
    automationsLogger.debug(
      `country condition skipped: session ${session.id} country '${raw}' did not normalize to an ISO code`
    );
    return { matched: false, actual: raw };
  }

  return {
    matched: compare(country, condition.operator, normalizeCountryConditionValue(condition.value)),
    actual: country,
  };
};

const evaluateIpInRange: ConditionEvaluator = (
  context: SessionEvaluationContext,
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

const evaluateServerId: ServerConditionEvaluator = (
  context: ServerEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { server } = context;

  return {
    matched: compare(server.id, condition.operator, condition.value),
    actual: server.id,
  };
};

const evaluateMediaType: ConditionEvaluator = (
  context: SessionEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const { session } = context;

  return {
    matched: compare(session.mediaType, condition.operator, condition.value),
    actual: session.mediaType,
  };
};

// ============================================================================
// Media Evaluators
// ============================================================================

/** Every media field reads the item the sync just wrote; any other context has none. */
const NO_MEDIA: EvaluatorResult = { matched: false, actual: null };

const evaluateLibraryItemType: ConditionEvaluator = (
  context: SessionEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const media = context.media;
  if (!media) return NO_MEDIA;
  return { matched: compare(media.type, condition.operator, condition.value), actual: media.type };
};

const evaluateLibraryName: ConditionEvaluator = (
  context: SessionEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const media = context.media;
  if (!media) return NO_MEDIA;
  return {
    matched: compare(media.libraryName, condition.operator, condition.value),
    actual: media.libraryName,
  };
};

/** Ranked on both sides, so the stored '4k' clears a picked '4K' and "at least" is one row. */
const evaluateResolutionAfter: ConditionEvaluator = (
  context: SessionEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const media = context.media;
  if (!media) return NO_MEDIA;
  const actual = media.quality.resolution;
  const rank = resolutionTierRank(actual);
  const threshold =
    typeof condition.value === 'string' ? resolutionTierRank(condition.value) : null;
  if (rank === null || threshold === null) return { matched: false, actual };
  return { matched: compare(rank, condition.operator, threshold), actual };
};

const evaluateDynamicRangeAfter: ConditionEvaluator = (
  context: SessionEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const media = context.media;
  if (!media) return NO_MEDIA;
  const actual = media.quality.dynamicRange;
  if (actual === null) return { matched: false, actual };
  return { matched: compare(actual, condition.operator, condition.value), actual };
};

/** Both parsers upper-case the codec, so the comparison folds case on both sides. */
const evaluateVideoCodecAfter: ConditionEvaluator = (
  context: SessionEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const media = context.media;
  if (!media) return NO_MEDIA;
  const actual = media.quality.videoCodec;
  if (actual === null) return { matched: false, actual };
  const value =
    typeof condition.value === 'string' ? condition.value.toLowerCase() : condition.value;
  return { matched: compare(actual.toLowerCase(), condition.operator, value), actual };
};

const evaluateAudioChannelsAfter: ConditionEvaluator = (
  context: SessionEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const media = context.media;
  if (!media) return NO_MEDIA;
  const actual = media.quality.audioChannels;
  if (actual === null) return { matched: false, actual };
  return { matched: compare(actual, condition.operator, condition.value), actual };
};

const evaluateFileSizeAfter: ConditionEvaluator = (
  context: SessionEvaluationContext,
  condition: Condition
): EvaluatorResult => {
  const media = context.media;
  if (!media) return NO_MEDIA;
  const bytes = media.quality.fileSize;
  if (bytes === null) return { matched: false, actual: null };
  const gb = bytes / BYTES_PER_GB;
  return { matched: compare(gb, condition.operator, condition.value), actual: gb };
};

// ============================================================================
// Evaluator Registry
// ============================================================================

// Each evaluator is annotated with the context it reads; the engine checks the
// field's `requires` against the context before it calls one.
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
  media_type: evaluateMediaType,

  // Media
  library_item_type: evaluateLibraryItemType,
  library_name: evaluateLibraryName,
  resolution_after: evaluateResolutionAfter,
  dynamic_range_after: evaluateDynamicRangeAfter,
  video_codec_after: evaluateVideoCodecAfter,
  audio_channels_after: evaluateAudioChannelsAfter,
  file_size_after: evaluateFileSizeAfter,
};

// Export helper functions for testing
export {
  calculateDistanceKm,
  getResolution,
  normalizeDeviceType,
  normalizePlatform,
  resolutionToNumber,
};
