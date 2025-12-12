import type { ViolationWithDetails } from '@tracearr/shared';

/**
 * Format violation data into readable description based on rule type
 */
export function getViolationDescription(violation: ViolationWithDetails): string {
  const data = violation.data;
  const ruleType = violation.rule?.type;

  if (!data || !ruleType) {
    return 'Rule violation detected';
  }

  switch (ruleType) {
    case 'impossible_travel': {
      const from = data.fromCity || data.fromLocation || 'unknown location';
      const to = data.toCity || data.toLocation || 'unknown location';
      const speed = typeof data.calculatedSpeedKmh === 'number'
        ? `${Math.round(data.calculatedSpeedKmh)} km/h`
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
    default:
      return 'Rule violation detected';
  }
}

/**
 * Get detailed violation information formatted for display
 */
export function getViolationDetails(violation: ViolationWithDetails): Record<string, unknown> {
  const data = violation.data;
  const ruleType = violation.rule?.type;

  if (!data || !ruleType) {
    return {};
  }

  const details: Record<string, unknown> = {};

  switch (ruleType) {
    case 'impossible_travel': {
      if (data.fromCity) details['From City'] = data.fromCity;
      if (data.fromLocation) details['From Location'] = data.fromLocation;
      if (data.toCity) details['To City'] = data.toCity;
      if (data.toLocation) details['To Location'] = data.toLocation;
      if (typeof data.calculatedSpeedKmh === 'number') {
        details['Calculated Speed'] = `${Math.round(data.calculatedSpeedKmh)} km/h`;
      }
      if (typeof data.distanceKm === 'number') {
        details['Distance'] = `${Math.round(data.distanceKm)} km`;
      }
      if (typeof data.timeWindowMinutes === 'number') {
        details['Time Window'] = `${Math.round(data.timeWindowMinutes)} minutes`;
      }
      break;
    }
    case 'simultaneous_locations': {
      const locations = data.locations as string[] | undefined;
      const count = data.locationCount as number | undefined;
      if (count) details['Location Count'] = count;
      if (locations && locations.length > 0) {
        details['Locations'] = locations;
      }
      break;
    }
    case 'device_velocity': {
      if (typeof data.ipCount === 'number') details['IP Count'] = data.ipCount;
      if (typeof data.windowHours === 'number') details['Time Window'] = `${data.windowHours} hours`;
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
  }

  return details;
}

