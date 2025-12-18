/**
 * GeoIP lookup service using MaxMind GeoLite2 database
 */

import maxmind, { type CityResponse, type Reader } from 'maxmind';
import { GEOIP_CONFIG } from '@tracearr/shared';

export interface GeoLocation {
  city: string | null;
  region: string | null; // State/province/subdivision
  country: string | null;
  countryCode: string | null;
  lat: number | null;
  lon: number | null;
}

const NULL_LOCATION: GeoLocation = {
  city: null,
  region: null,
  country: null,
  countryCode: null,
  lat: null,
  lon: null,
};

const LOCAL_LOCATION: GeoLocation = {
  city: 'Local',
  region: null,
  country: 'Local Network',
  countryCode: null,
  lat: null,
  lon: null,
};

export class GeoIPService {
  private reader: Reader<CityResponse> | null = null;
  private initialized = false;

  async initialize(dbPath: string): Promise<void> {
    try {
      this.reader = await maxmind.open<CityResponse>(dbPath);
      this.initialized = true;
    } catch (error) {
      // Graceful degradation - service works without GeoIP database
      console.warn(
        `GeoIP database not loaded: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      this.reader = null;
      this.initialized = true;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  hasDatabase(): boolean {
    return this.reader !== null;
  }

  lookup(ip: string): GeoLocation {
    // Return "Local" for private/local network IPs
    if (this.isPrivateIP(ip)) {
      return LOCAL_LOCATION;
    }

    // Return null location if no database loaded
    if (!this.reader) {
      return NULL_LOCATION;
    }

    try {
      const result = this.reader.get(ip);

      if (!result) {
        return NULL_LOCATION;
      }

      // Get the most specific subdivision (state/province)
      // MaxMind returns subdivisions as an array, most specific last
      const subdivisions = result.subdivisions;
      const region =
        subdivisions && subdivisions.length > 0 ? (subdivisions[0]?.names?.en ?? null) : null;

      return {
        city: result.city?.names?.en ?? null,
        region,
        country: result.country?.names?.en ?? null,
        countryCode: result.country?.iso_code ?? null,
        lat: result.location?.latitude ?? null,
        lon: result.location?.longitude ?? null,
      };
    } catch {
      return NULL_LOCATION;
    }
  }

  isPrivateIP(ip: string): boolean {
    // Handle IPv6 localhost
    if (ip === '::1' || ip === '::ffff:127.0.0.1') {
      return true;
    }

    // Strip IPv6 prefix for mapped addresses
    const cleanIp = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

    // Check if it's an IPv4 address
    const parts = cleanIp.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      // Not a valid IPv4 - could be IPv6
      return this.isPrivateIPv6(ip);
    }

    // 10.0.0.0 - 10.255.255.255
    if (parts[0] === 10) {
      return true;
    }

    // 172.16.0.0 - 172.31.255.255
    if (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31) {
      return true;
    }

    // 192.168.0.0 - 192.168.255.255
    if (parts[0] === 192 && parts[1] === 168) {
      return true;
    }

    // 127.0.0.0 - 127.255.255.255 (localhost)
    if (parts[0] === 127) {
      return true;
    }

    // 169.254.0.0 - 169.254.255.255 (link-local)
    if (parts[0] === 169 && parts[1] === 254) {
      return true;
    }

    return false;
  }

  private isPrivateIPv6(ip: string): boolean {
    // Simplified check for common private IPv6 ranges
    const lower = ip.toLowerCase();

    // Loopback
    if (lower === '::1') {
      return true;
    }

    // Link-local (fe80::/10)
    if (lower.startsWith('fe80:')) {
      return true;
    }

    // Unique local addresses (fc00::/7)
    if (lower.startsWith('fc') || lower.startsWith('fd')) {
      return true;
    }

    return false;
  }

  /**
   * Calculate the distance between two locations using the Haversine formula
   * @returns Distance in kilometers, or null if coordinates are missing
   */
  calculateDistance(loc1: GeoLocation, loc2: GeoLocation): number | null {
    if (loc1.lat === null || loc1.lon === null || loc2.lat === null || loc2.lon === null) {
      return null;
    }

    const toRadians = (deg: number): number => (deg * Math.PI) / 180;

    const lat1 = toRadians(loc1.lat);
    const lat2 = toRadians(loc2.lat);
    const deltaLat = toRadians(loc2.lat - loc1.lat);
    const deltaLon = toRadians(loc2.lon - loc1.lon);

    const a =
      Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return GEOIP_CONFIG.EARTH_RADIUS_KM * c;
  }

  /**
   * Check if travel between two locations is physically possible within a time window
   * @param loc1 First location
   * @param loc2 Second location
   * @param timeDeltaMs Time difference in milliseconds
   * @param maxSpeedKmh Maximum plausible travel speed in km/h (default: 900 for commercial aircraft)
   * @returns true if travel is impossible (violation detected)
   */
  isImpossibleTravel(
    loc1: GeoLocation,
    loc2: GeoLocation,
    timeDeltaMs: number,
    maxSpeedKmh: number = 900
  ): boolean {
    const distance = this.calculateDistance(loc1, loc2);

    if (distance === null) {
      return false; // Can't determine without coordinates
    }

    const timeDeltaHours = timeDeltaMs / (1000 * 60 * 60);

    if (timeDeltaHours <= 0) {
      // Same time or negative time - impossible if distance > 0
      return distance > 0;
    }

    const requiredSpeedKmh = distance / timeDeltaHours;
    return requiredSpeedKmh > maxSpeedKmh;
  }
}

export const geoipService = new GeoIPService();
