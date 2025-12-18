import type { ViolationWithDetails, UnitSystem } from '@tracearr/shared';
import { formatSpeed, formatDistance } from '@tracearr/shared';

/**
 * Format violation data into readable description based on rule type
 */
export function getViolationDescription(
  violation: ViolationWithDetails,
  unitSystem: UnitSystem = 'metric'
): string {
  const data = violation.data;
  const ruleType = violation.rule?.type;

  if (!data || !ruleType) {
    return 'Rule violation detected';
  }

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
    // Handle {city, country} format
    if (obj.city || obj.country) {
      const parts = [obj.city, obj.country].filter(Boolean);
      return parts.join(', ') || 'Unknown';
    }
    // Handle {lat, lon} format - format as coordinates
    if (typeof obj.lat === 'number' && typeof obj.lon === 'number') {
      return `${obj.lat.toFixed(2)}°, ${obj.lon.toFixed(2)}°`;
    }
  }
  return String(loc);
}

/**
 * Get detailed violation information formatted for display
 */
export function getViolationDetails(
  violation: ViolationWithDetails,
  unitSystem: UnitSystem = 'metric'
): Record<string, unknown> {
  const data = violation.data;
  const ruleType = violation.rule?.type;

  if (!data || !ruleType) {
    return {};
  }

  const details: Record<string, unknown> = {};

  switch (ruleType) {
    case 'impossible_travel': {
      if (data.fromCity) details['From City'] = data.fromCity;
      if (data.fromLocation) details['From Location'] = formatLocationValue(data.fromLocation);
      if (data.toCity) details['To City'] = data.toCity;
      if (data.toLocation) details['To Location'] = formatLocationValue(data.toLocation);
      // Format previousLocation/currentLocation if present (lat/lon objects)
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
        // Convert location objects to readable strings
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
  }

  return details;
}
