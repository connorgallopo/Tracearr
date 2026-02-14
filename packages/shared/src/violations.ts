import type {
  ViolationWithDetails,
  ViolationSessionInfo,
  UnitSystem,
  GroupEvidence,
  ConditionEvidence,
  ConditionField,
} from './types.js';
import { formatSpeed, formatDistance } from './constants.js';

const CONDITION_FIELD_LABELS: Record<ConditionField, string> = {
  concurrent_streams: 'Concurrent Streams',
  active_session_distance_km: 'Session Distance',
  travel_speed_kmh: 'Travel Speed',
  unique_ips_in_window: 'Unique IPs',
  unique_devices_in_window: 'Unique Devices',
  inactive_days: 'Inactive Days',
  bandwidth_usage_gb: 'Bandwidth Usage',
  source_resolution: 'Source Resolution',
  output_resolution: 'Output Resolution',
  is_transcoding: 'Transcoding',
  is_transcode_downgrade: 'Transcode Downgrade',
  source_bitrate_mbps: 'Source Bitrate',
  user_id: 'User',
  trust_score: 'Trust Score',
  account_age_days: 'Account Age',
  device_type: 'Device Type',
  client_name: 'Client',
  platform: 'Platform',
  is_local_network: 'Local Network',
  country: 'Country',
  ip_in_range: 'IP Range',
  server_id: 'Server',
  library_id: 'Library',
  media_type: 'Media Type',
};

const OPERATOR_LABELS: Record<string, string> = {
  eq: '=',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  in: 'in',
  not_in: 'not in',
  contains: 'contains',
  not_contains: 'does not contain',
};

/**
 * Collect all sessions from a violation (triggering + related), deduped by ID.
 * The triggering session always comes first.
 */
export function collectViolationSessions(violation: ViolationWithDetails): ViolationSessionInfo[] {
  const sessions: ViolationSessionInfo[] = [];
  const seenIds = new Set<string>();

  if (violation.session) {
    sessions.push(violation.session);
    seenIds.add(violation.session.id);
  }

  if (violation.relatedSessions) {
    for (const session of violation.relatedSessions) {
      if (!seenIds.has(session.id)) {
        sessions.push(session);
        seenIds.add(session.id);
      }
    }
  }

  return sessions;
}

/**
 * Format violation data into a readable description based on rule type.
 * Returns a single-line human-readable summary of what the violation represents.
 */
export function getViolationDescription(
  violation: ViolationWithDetails,
  unitSystem: UnitSystem = 'metric'
): string {
  const data = violation.data;
  const ruleType = violation.rule?.type;

  // V2 custom rules don't have a type — check for evidence or custom message in data
  if (!ruleType) {
    if (violation.evidence) {
      return formatEvidenceDescription(violation.evidence, unitSystem);
    }
    if (data?.message && typeof data.message === 'string') {
      return data.message;
    }
    if (violation.rule?.name) {
      return `Triggered rule: ${violation.rule.name}`;
    }
    return 'Custom rule violation detected';
  }

  if (!data) return 'Rule violation detected';

  switch (ruleType) {
    case 'impossible_travel': {
      const from = data.fromCity || data.fromLocation || 'unknown location';
      const to = data.toCity || data.toLocation || 'unknown location';
      const speed =
        typeof data.calculatedSpeedKmh === 'number'
          ? formatSpeed(data.calculatedSpeedKmh, unitSystem)
          : 'impossible speed';
      return `Traveled from ${from} to ${to} at ${speed}`;
    }
    case 'simultaneous_locations': {
      const locations = data.locations as string[] | undefined;
      const count = data.locationCount as number | undefined;
      if (locations && locations.length > 0) {
        return `Active from ${locations.length} locations: ${locations.slice(0, 2).join(', ')}${locations.length > 2 ? '...' : ''}`;
      }
      if (count) {
        return `Streaming from ${count} different locations simultaneously`;
      }
      return 'Streaming from multiple locations simultaneously';
    }
    case 'device_velocity': {
      const ipCount = data.ipCount as number | undefined;
      const windowHours = data.windowHours as number | undefined;
      if (ipCount && windowHours) {
        return `${ipCount} different IPs used in ${windowHours}h window`;
      }
      return 'Too many unique devices in short period';
    }
    case 'concurrent_streams': {
      const streamCount = data.streamCount as number | undefined;
      const maxStreams = data.maxStreams as number | undefined;
      if (streamCount && maxStreams) {
        return `${streamCount} concurrent streams (limit: ${maxStreams})`;
      }
      return 'Exceeded concurrent stream limit';
    }
    case 'geo_restriction': {
      const country = data.country as string | undefined;
      const blockedCountry = data.blockedCountry as string | undefined;
      if (country || blockedCountry) {
        return `Streaming from blocked region: ${country || blockedCountry}`;
      }
      return 'Streaming from restricted location';
    }
    case 'account_inactivity': {
      const inactiveDays = data.inactiveDays as number | undefined;
      const neverActive = data.neverActive as boolean | undefined;
      if (neverActive) {
        return 'Account has never had any activity';
      }
      if (inactiveDays !== undefined) {
        if (inactiveDays === 1) {
          return 'Account has been inactive for 1 day';
        }
        return `Account has been inactive for ${inactiveDays} days`;
      }
      return 'Account has been inactive';
    }
    default:
      return 'Rule violation detected';
  }
}

/**
 * Format a location object or value to a readable string
 */
function formatLocationValue(loc: unknown): string {
  if (typeof loc === 'string') return loc;
  if (loc && typeof loc === 'object') {
    const obj = loc as Record<string, unknown>;
    if (obj.city || obj.country) {
      const parts = [obj.city, obj.country].filter(Boolean);
      return parts.join(', ') || 'Unknown';
    }
    if (typeof obj.lat === 'number' && typeof obj.lon === 'number') {
      return `${obj.lat.toFixed(2)}°, ${obj.lon.toFixed(2)}°`;
    }
  }
  return String(loc);
}

/**
 * Get detailed violation information formatted for display.
 * Returns key-value pairs of violation-specific data points.
 */
export function getViolationDetails(
  violation: ViolationWithDetails,
  unitSystem: UnitSystem = 'metric'
): Record<string, unknown> {
  const data = violation.data;
  const ruleType = violation.rule?.type;

  if (!ruleType) {
    if (violation.evidence) {
      return formatEvidenceDetails(violation.evidence, unitSystem);
    }
    return {};
  }

  if (!data) {
    return {};
  }

  const details: Record<string, unknown> = {};

  switch (ruleType) {
    case 'impossible_travel': {
      if (data.fromCity) details['From City'] = data.fromCity;
      if (data.fromLocation) details['From Location'] = formatLocationValue(data.fromLocation);
      if (data.toCity) details['To City'] = data.toCity;
      if (data.toLocation) details['To Location'] = formatLocationValue(data.toLocation);
      if (data.previousLocation)
        details['Previous Location'] = formatLocationValue(data.previousLocation);
      if (data.currentLocation)
        details['Current Location'] = formatLocationValue(data.currentLocation);
      if (typeof data.calculatedSpeedKmh === 'number') {
        details['Calculated Speed'] = formatSpeed(data.calculatedSpeedKmh, unitSystem);
      }
      if (typeof data.distanceKm === 'number') {
        details['Distance'] = formatDistance(data.distanceKm, unitSystem);
      }
      if (typeof data.distance === 'number') {
        details['Distance'] = formatDistance(data.distance, unitSystem);
      }
      if (typeof data.timeWindowMinutes === 'number') {
        details['Time Window'] = `${Math.round(data.timeWindowMinutes)} minutes`;
      }
      if (typeof data.timeDiffHours === 'number') {
        const minutes = Math.round(data.timeDiffHours * 60);
        details['Time Window'] =
          minutes < 60 ? `${minutes} minutes` : `${data.timeDiffHours.toFixed(1)} hours`;
      }
      break;
    }
    case 'simultaneous_locations': {
      const locations = data.locations as unknown[] | undefined;
      const count = data.locationCount as number | undefined;
      if (count) details['Location Count'] = count;
      if (locations && locations.length > 0) {
        details['Locations'] = locations.map(formatLocationValue);
      }
      if (typeof data.distance === 'number') {
        details['Distance Apart'] = formatDistance(data.distance, unitSystem);
      }
      break;
    }
    case 'device_velocity': {
      if (typeof data.ipCount === 'number') details['IP Count'] = data.ipCount;
      if (typeof data.windowHours === 'number')
        details['Time Window'] = `${data.windowHours} hours`;
      if (Array.isArray(data.ipAddresses)) {
        details['IP Addresses'] = data.ipAddresses;
      }
      break;
    }
    case 'concurrent_streams': {
      if (typeof data.streamCount === 'number') details['Current Streams'] = data.streamCount;
      if (typeof data.maxStreams === 'number') details['Max Streams'] = data.maxStreams;
      break;
    }
    case 'geo_restriction': {
      if (data.country) details['Country'] = data.country;
      if (data.blockedCountry) details['Blocked Country'] = data.blockedCountry;
      if (data.ipAddress) details['IP Address'] = data.ipAddress;
      break;
    }
    case 'account_inactivity': {
      if (typeof data.inactiveDays === 'number') {
        details['Days Inactive'] = data.inactiveDays;
      }
      if (typeof data.thresholdDays === 'number') {
        details['Threshold'] = `${data.thresholdDays} days`;
      }
      if (data.lastActivityAt) {
        details['Last Activity'] = new Date(data.lastActivityAt as string).toLocaleDateString();
      }
      if (data.neverActive) {
        details['Status'] = 'Never active';
      }
      break;
    }
  }

  return details;
}

/**
 * Format a single condition's actual value into a human-readable string.
 */
function formatConditionActual(condition: ConditionEvidence, unitSystem: UnitSystem): string {
  const { field, actual } = condition;

  if (actual === null || actual === undefined) return 'unknown';

  switch (field) {
    case 'travel_speed_kmh':
      return typeof actual === 'number' ? formatSpeed(actual, unitSystem) : String(actual);
    case 'active_session_distance_km':
      return typeof actual === 'number' ? formatDistance(actual, unitSystem) : String(actual);
    case 'source_bitrate_mbps':
      return typeof actual === 'number' ? `${actual} Mbps` : String(actual);
    case 'inactive_days':
    case 'account_age_days':
      return typeof actual === 'number' ? `${actual} days` : String(actual);
    case 'bandwidth_usage_gb':
      return typeof actual === 'number' ? `${actual} GB` : String(actual);
    default:
      return String(actual);
  }
}

/**
 * Build a human-readable description from evidence groups.
 * Shows only matched conditions for a concise summary.
 */
export function formatEvidenceDescription(
  evidence: GroupEvidence[],
  unitSystem: UnitSystem = 'metric'
): string {
  const parts: string[] = [];

  for (const group of evidence) {
    const matched = group.conditions.filter((c) => c.matched);
    for (const cond of matched) {
      const label = CONDITION_FIELD_LABELS[cond.field] ?? cond.field;
      const actual = formatConditionActual(cond, unitSystem);
      const op = OPERATOR_LABELS[cond.operator] ?? cond.operator;
      const threshold = String(cond.threshold);
      parts.push(`${label}: ${actual} (${op} ${threshold})`);
    }
  }

  return parts.length > 0 ? parts.join(', ') : 'Rule conditions matched';
}

/**
 * Build detailed key-value pairs from evidence for the details panel.
 */
export function formatEvidenceDetails(
  evidence: GroupEvidence[],
  unitSystem: UnitSystem = 'metric'
): Record<string, unknown> {
  const details: Record<string, unknown> = {};

  for (const group of evidence) {
    for (const cond of group.conditions) {
      const label = CONDITION_FIELD_LABELS[cond.field] ?? cond.field;
      const actual = formatConditionActual(cond, unitSystem);

      details[label] = actual;

      // Add field-specific details
      if (cond.field === 'travel_speed_kmh' && cond.details) {
        if (typeof cond.details.distance === 'number') {
          details['Travel Distance'] = formatDistance(cond.details.distance, unitSystem);
        }
        if (cond.details.previousLocation) {
          details['Previous Location'] = formatLocationValue(cond.details.previousLocation);
        }
        if (cond.details.currentLocation) {
          details['Current Location'] = formatLocationValue(cond.details.currentLocation);
        }
      }
      if (cond.field === 'unique_ips_in_window' && cond.details) {
        if (Array.isArray(cond.details.ips)) {
          details['IP Addresses'] = cond.details.ips;
        }
      }
      if (cond.field === 'unique_devices_in_window' && cond.details) {
        if (Array.isArray(cond.details.devices)) {
          details['Devices'] = cond.details.devices;
        }
      }
      if (cond.field === 'inactive_days' && cond.details?.lastActivityAt) {
        details['Last Activity'] = new Date(
          cond.details.lastActivityAt as string
        ).toLocaleDateString();
      }
    }
  }

  return details;
}

export { CONDITION_FIELD_LABELS, OPERATOR_LABELS };
