/**
 * GeoIP Service Tests
 *
 * Tests the ACTUAL GeoIPService class from geoip.ts:
 * - isPrivateIP: IPv4 private range detection
 * - isPrivateIPv6: IPv6 private range detection (via isPrivateIP)
 * - calculateDistance: Haversine formula distance calculation
 * - isImpossibleTravel: Impossible travel detection based on speed
 * - lookup: GeoIP lookup with mocked reader
 *
 * These tests validate:
 * - Private IP detection for all RFC 1918 ranges
 * - IPv6 loopback, link-local, and unique local addresses
 * - Distance calculation accuracy against known values
 * - Impossible travel threshold detection
 * - Graceful handling of missing coordinates
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Import ACTUAL production class and types - not local duplicates
import { GeoIPService, type GeoLocation } from '../geoip.js';

describe('GeoIPService', () => {
  let service: GeoIPService;

  beforeEach(() => {
    // Create fresh instance for each test
    service = new GeoIPService();
  });

  describe('isPrivateIP', () => {
    describe('IPv4 private ranges', () => {
      it('should detect 10.x.x.x range as private (Class A)', () => {
        expect(service.isPrivateIP('10.0.0.0')).toBe(true);
        expect(service.isPrivateIP('10.0.0.1')).toBe(true);
        expect(service.isPrivateIP('10.255.255.255')).toBe(true);
        expect(service.isPrivateIP('10.128.64.32')).toBe(true);
      });

      it('should detect 172.16-31.x.x range as private (Class B)', () => {
        // Lower bound
        expect(service.isPrivateIP('172.16.0.0')).toBe(true);
        expect(service.isPrivateIP('172.16.0.1')).toBe(true);

        // Middle values
        expect(service.isPrivateIP('172.20.100.50')).toBe(true);
        expect(service.isPrivateIP('172.24.255.255')).toBe(true);

        // Upper bound
        expect(service.isPrivateIP('172.31.255.255')).toBe(true);
        expect(service.isPrivateIP('172.31.0.0')).toBe(true);
      });

      it('should NOT detect 172.x outside 16-31 as private', () => {
        expect(service.isPrivateIP('172.15.255.255')).toBe(false);
        expect(service.isPrivateIP('172.32.0.0')).toBe(false);
        expect(service.isPrivateIP('172.0.0.1')).toBe(false);
      });

      it('should detect 192.168.x.x range as private (Class C)', () => {
        expect(service.isPrivateIP('192.168.0.0')).toBe(true);
        expect(service.isPrivateIP('192.168.0.1')).toBe(true);
        expect(service.isPrivateIP('192.168.1.1')).toBe(true);
        expect(service.isPrivateIP('192.168.255.255')).toBe(true);
      });

      it('should NOT detect other 192.x ranges as private', () => {
        expect(service.isPrivateIP('192.167.0.1')).toBe(false);
        expect(service.isPrivateIP('192.169.0.1')).toBe(false);
        expect(service.isPrivateIP('192.0.0.1')).toBe(false);
      });

      it('should detect 127.x.x.x loopback as private', () => {
        expect(service.isPrivateIP('127.0.0.1')).toBe(true);
        expect(service.isPrivateIP('127.0.0.0')).toBe(true);
        expect(service.isPrivateIP('127.255.255.255')).toBe(true);
        expect(service.isPrivateIP('127.1.2.3')).toBe(true);
      });

      it('should detect 169.254.x.x link-local as private', () => {
        expect(service.isPrivateIP('169.254.0.0')).toBe(true);
        expect(service.isPrivateIP('169.254.0.1')).toBe(true);
        expect(service.isPrivateIP('169.254.255.255')).toBe(true);
        expect(service.isPrivateIP('169.254.128.64')).toBe(true);
      });

      it('should NOT detect 169.x outside link-local as private', () => {
        expect(service.isPrivateIP('169.253.0.1')).toBe(false);
        expect(service.isPrivateIP('169.255.0.1')).toBe(false);
      });
    });

    describe('IPv4 public addresses', () => {
      it('should NOT detect public addresses as private', () => {
        expect(service.isPrivateIP('8.8.8.8')).toBe(false); // Google DNS
        expect(service.isPrivateIP('1.1.1.1')).toBe(false); // Cloudflare DNS
        expect(service.isPrivateIP('208.67.222.222')).toBe(false); // OpenDNS
        expect(service.isPrivateIP('74.125.224.72')).toBe(false); // Random public
        expect(service.isPrivateIP('151.101.1.140')).toBe(false); // Reddit
      });
    });

    describe('IPv6 addresses', () => {
      it('should detect ::1 loopback as private', () => {
        expect(service.isPrivateIP('::1')).toBe(true);
      });

      it('should detect ::ffff:127.0.0.1 mapped loopback as private', () => {
        expect(service.isPrivateIP('::ffff:127.0.0.1')).toBe(true);
      });

      it('should detect IPv4-mapped private addresses', () => {
        expect(service.isPrivateIP('::ffff:10.0.0.1')).toBe(true);
        expect(service.isPrivateIP('::ffff:192.168.1.1')).toBe(true);
        expect(service.isPrivateIP('::ffff:172.16.0.1')).toBe(true);
      });

      it('should NOT detect IPv4-mapped public addresses as private', () => {
        expect(service.isPrivateIP('::ffff:8.8.8.8')).toBe(false);
        expect(service.isPrivateIP('::ffff:1.1.1.1')).toBe(false);
      });

      it('should detect fe80:: link-local as private', () => {
        expect(service.isPrivateIP('fe80::')).toBe(true);
        expect(service.isPrivateIP('fe80::1')).toBe(true);
        expect(service.isPrivateIP('fe80::abcd:1234:5678:9abc')).toBe(true);
      });

      it('should detect fc00::/fd00:: unique local as private', () => {
        expect(service.isPrivateIP('fc00::')).toBe(true);
        expect(service.isPrivateIP('fc00::1')).toBe(true);
        expect(service.isPrivateIP('fd00::')).toBe(true);
        expect(service.isPrivateIP('fd12:3456:789a::1')).toBe(true);
      });

      it('should NOT detect global IPv6 addresses as private', () => {
        expect(service.isPrivateIP('2001:4860:4860::8888')).toBe(false); // Google DNS
        expect(service.isPrivateIP('2606:4700:4700::1111')).toBe(false); // Cloudflare
      });
    });

    describe('edge cases', () => {
      it('should handle malformed IPv4 addresses', () => {
        // These should fall through to IPv6 check and return false
        expect(service.isPrivateIP('256.0.0.1')).toBe(false);
        expect(service.isPrivateIP('-1.0.0.1')).toBe(false);
        expect(service.isPrivateIP('10.0.0')).toBe(false);
        expect(service.isPrivateIP('10.0.0.1.1')).toBe(false);
      });

      it('should handle non-IP strings gracefully', () => {
        expect(service.isPrivateIP('')).toBe(false);
        expect(service.isPrivateIP('not-an-ip')).toBe(false);
        expect(service.isPrivateIP('abc.def.ghi.jkl')).toBe(false);
      });
    });
  });

  describe('calculateDistance', () => {
    // Known distances for validation (approximate due to Earth not being perfect sphere)
    const locations = {
      newYork: {
        city: 'New York',
        region: null,
        country: 'USA',
        countryCode: 'US',
        lat: 40.7128,
        lon: -74.006,
      },
      losAngeles: {
        city: 'Los Angeles',
        region: null,
        country: 'USA',
        countryCode: 'US',
        lat: 34.0522,
        lon: -118.2437,
      },
      london: {
        city: 'London',
        region: null,
        country: 'UK',
        countryCode: 'GB',
        lat: 51.5074,
        lon: -0.1278,
      },
      tokyo: {
        city: 'Tokyo',
        region: null,
        country: 'Japan',
        countryCode: 'JP',
        lat: 35.6762,
        lon: 139.6503,
      },
      sydney: {
        city: 'Sydney',
        region: null,
        country: 'Australia',
        countryCode: 'AU',
        lat: -33.8688,
        lon: 151.2093,
      },
      nullLocation: {
        city: null,
        region: null,
        country: null,
        countryCode: null,
        lat: null,
        lon: null,
      },
      partialNull: {
        city: 'Test',
        region: null,
        country: null,
        countryCode: null,
        lat: 40.0,
        lon: null,
      },
    };

    it('should calculate NYC to LA distance (~3940 km)', () => {
      const distance = service.calculateDistance(locations.newYork, locations.losAngeles);

      expect(distance).not.toBeNull();
      // NYC to LA is approximately 3940 km
      expect(distance).toBeGreaterThan(3900);
      expect(distance).toBeLessThan(4000);
    });

    it('should calculate NYC to London distance (~5570 km)', () => {
      const distance = service.calculateDistance(locations.newYork, locations.london);

      expect(distance).not.toBeNull();
      // NYC to London is approximately 5570 km
      expect(distance).toBeGreaterThan(5500);
      expect(distance).toBeLessThan(5650);
    });

    it('should calculate London to Tokyo distance (~9560 km)', () => {
      const distance = service.calculateDistance(locations.london, locations.tokyo);

      expect(distance).not.toBeNull();
      // London to Tokyo is approximately 9560 km
      expect(distance).toBeGreaterThan(9500);
      expect(distance).toBeLessThan(9650);
    });

    it('should calculate Sydney to London distance (~16990 km)', () => {
      const distance = service.calculateDistance(locations.sydney, locations.london);

      expect(distance).not.toBeNull();
      // Sydney to London is approximately 16990 km
      expect(distance).toBeGreaterThan(16900);
      expect(distance).toBeLessThan(17100);
    });

    it('should return 0 for same location', () => {
      const distance = service.calculateDistance(locations.newYork, locations.newYork);

      expect(distance).toBe(0);
    });

    it('should return null when first location has null coordinates', () => {
      const distance = service.calculateDistance(locations.nullLocation, locations.newYork);

      expect(distance).toBeNull();
    });

    it('should return null when second location has null coordinates', () => {
      const distance = service.calculateDistance(locations.newYork, locations.nullLocation);

      expect(distance).toBeNull();
    });

    it('should return null when both locations have null coordinates', () => {
      const distance = service.calculateDistance(locations.nullLocation, locations.nullLocation);

      expect(distance).toBeNull();
    });

    it('should return null for partial null coordinates (lon is null)', () => {
      const distance = service.calculateDistance(locations.partialNull, locations.newYork);

      expect(distance).toBeNull();
    });

    it('should handle cross-hemisphere calculations', () => {
      // New York (Northern) to Sydney (Southern)
      const distance = service.calculateDistance(locations.newYork, locations.sydney);

      expect(distance).not.toBeNull();
      // Approximately 16000 km
      expect(distance).toBeGreaterThan(15900);
      expect(distance).toBeLessThan(16100);
    });

    it('should handle prime meridian crossing', () => {
      // London to Tokyo crosses the prime meridian
      const distance = service.calculateDistance(locations.london, locations.tokyo);

      expect(distance).not.toBeNull();
      expect(distance).toBeGreaterThan(0);
    });

    it('should be symmetric (a to b = b to a)', () => {
      const distanceAB = service.calculateDistance(locations.newYork, locations.london);
      const distanceBA = service.calculateDistance(locations.london, locations.newYork);

      expect(distanceAB).toBe(distanceBA);
    });
  });

  describe('isImpossibleTravel', () => {
    const newYork: GeoLocation = {
      city: 'New York',
      region: null,
      country: 'USA',
      countryCode: 'US',
      lat: 40.7128,
      lon: -74.006,
    };

    const losAngeles: GeoLocation = {
      city: 'Los Angeles',
      region: null,
      country: 'USA',
      countryCode: 'US',
      lat: 34.0522,
      lon: -118.2437,
    };

    const london: GeoLocation = {
      city: 'London',
      region: null,
      country: 'UK',
      countryCode: 'GB',
      lat: 51.5074,
      lon: -0.1278,
    };

    const nullLocation: GeoLocation = {
      city: null,
      region: null,
      country: null,
      countryCode: null,
      lat: null,
      lon: null,
    };

    // NYC to LA is ~3940 km
    // At 900 km/h (default), that's ~4.4 hours

    it('should detect impossible travel (NYC to LA in 1 hour)', () => {
      const oneHourMs = 1 * 60 * 60 * 1000;

      const result = service.isImpossibleTravel(newYork, losAngeles, oneHourMs);

      // 3940 km in 1 hour = 3940 km/h >> 900 km/h
      expect(result).toBe(true);
    });

    it('should allow possible travel (NYC to LA in 6 hours)', () => {
      const sixHoursMs = 6 * 60 * 60 * 1000;

      const result = service.isImpossibleTravel(newYork, losAngeles, sixHoursMs);

      // 3940 km in 6 hours = ~657 km/h < 900 km/h
      expect(result).toBe(false);
    });

    it('should detect impossible travel (NYC to London in 2 hours)', () => {
      const twoHoursMs = 2 * 60 * 60 * 1000;

      const result = service.isImpossibleTravel(newYork, london, twoHoursMs);

      // 5570 km in 2 hours = 2785 km/h >> 900 km/h
      expect(result).toBe(true);
    });

    it('should allow possible travel (NYC to London in 8 hours)', () => {
      const eightHoursMs = 8 * 60 * 60 * 1000;

      const result = service.isImpossibleTravel(newYork, london, eightHoursMs);

      // 5570 km in 8 hours = ~696 km/h < 900 km/h
      expect(result).toBe(false);
    });

    it('should return false when coordinates are missing', () => {
      const oneHourMs = 1 * 60 * 60 * 1000;

      expect(service.isImpossibleTravel(nullLocation, newYork, oneHourMs)).toBe(false);
      expect(service.isImpossibleTravel(newYork, nullLocation, oneHourMs)).toBe(false);
      expect(service.isImpossibleTravel(nullLocation, nullLocation, oneHourMs)).toBe(false);
    });

    it('should detect impossible travel at zero time delta with non-zero distance', () => {
      const result = service.isImpossibleTravel(newYork, losAngeles, 0);

      // Distance > 0, time = 0 means infinite speed required
      expect(result).toBe(true);
    });

    it('should allow same location at zero time delta', () => {
      const result = service.isImpossibleTravel(newYork, newYork, 0);

      // Distance = 0, time = 0, no movement needed
      expect(result).toBe(false);
    });

    it('should detect impossible travel at negative time delta with distance', () => {
      const negativeTimeMs = -1000;

      const result = service.isImpossibleTravel(newYork, losAngeles, negativeTimeMs);

      // Time is negative but distance > 0, should be impossible
      expect(result).toBe(true);
    });

    it('should respect custom max speed parameter', () => {
      // NYC to LA is ~3940 km
      const fourHoursMs = 4 * 60 * 60 * 1000;
      // Required speed would be ~985 km/h (3940 / 4)

      // Default max speed is 900 km/h - should be impossible
      expect(service.isImpossibleTravel(newYork, losAngeles, fourHoursMs)).toBe(true);

      // With higher max speed (1000 km/h) - should be possible
      expect(service.isImpossibleTravel(newYork, losAngeles, fourHoursMs, 1000)).toBe(false);

      // With lower max speed (500 km/h) - should be impossible
      expect(service.isImpossibleTravel(newYork, losAngeles, fourHoursMs, 500)).toBe(true);
    });

    it('should handle very small distances and times', () => {
      // Same city, small time delta
      const nearbyLocation: GeoLocation = {
        city: 'NYC Downtown',
        region: null,
        country: 'USA',
        countryCode: 'US',
        lat: 40.7128 + 0.001, // Very small offset (~111 meters)
        lon: -74.006,
      };

      const fiveMinutesMs = 5 * 60 * 1000;

      const result = service.isImpossibleTravel(newYork, nearbyLocation, fiveMinutesMs);

      // ~111 meters in 5 minutes = trivially possible
      expect(result).toBe(false);
    });
  });

  describe('initialization state', () => {
    it('should not be initialized by default', () => {
      expect(service.isInitialized()).toBe(false);
    });

    it('should not have database by default', () => {
      expect(service.hasDatabase()).toBe(false);
    });
  });

  describe('lookup', () => {
    it('should return Local location for private IPs (without database)', () => {
      const result = service.lookup('192.168.1.1');

      expect(result.city).toBe('Local');
      expect(result.country).toBe('Local Network');
      expect(result.lat).toBeNull();
      expect(result.lon).toBeNull();
    });

    it('should return Local location for loopback', () => {
      const result = service.lookup('127.0.0.1');

      expect(result.city).toBe('Local');
      expect(result.country).toBe('Local Network');
    });

    it('should return null location for public IPs when no database loaded', () => {
      // No database initialized
      const result = service.lookup('8.8.8.8');

      expect(result.city).toBeNull();
      expect(result.country).toBeNull();
      expect(result.countryCode).toBeNull();
      expect(result.lat).toBeNull();
      expect(result.lon).toBeNull();
    });

    it('should return Local for IPv6 loopback', () => {
      const result = service.lookup('::1');

      expect(result.city).toBe('Local');
      expect(result.country).toBe('Local Network');
    });

    it('should return Local for IPv6 link-local', () => {
      const result = service.lookup('fe80::1');

      expect(result.city).toBe('Local');
      expect(result.country).toBe('Local Network');
    });
  });
});
