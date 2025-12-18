/**
 * RuleEngine unit tests
 *
 * Tests all 5 rule types:
 * - impossible_travel: Detects physically impossible location changes
 * - simultaneous_locations: Detects same user streaming from distant locations simultaneously
 * - device_velocity: Detects too many unique IPs in a time window
 * - concurrent_streams: Detects exceeding stream limits
 * - geo_restriction: Detects streams from blocked countries
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RuleEngine } from '../rules.js';
import {
  createMockSession,
  createMockRule,
  createSessionsWithDifferentIps,
  TEST_LOCATIONS,
  calculateDistanceKm,
} from '../../test/fixtures.js';

describe('RuleEngine', () => {
  let ruleEngine: RuleEngine;

  beforeEach(() => {
    ruleEngine = new RuleEngine();
  });

  describe('evaluateSession', () => {
    it('should return empty array when no rules are active', async () => {
      const session = createMockSession();
      const results = await ruleEngine.evaluateSession(session, [], []);
      expect(results).toEqual([]);
    });

    it('should skip rules that do not apply to the user', async () => {
      const serverUserId = 'user-123';
      const otherServerUserId = 'user-456';
      const session = createMockSession({ serverUserId });

      // Rule applies only to a different user
      const rule = createMockRule('concurrent_streams', {
        serverUserId: otherServerUserId,
        params: { maxStreams: 1 },
      });

      const results = await ruleEngine.evaluateSession(session, [rule], []);
      expect(results).toEqual([]);
    });

    it('should apply global rules (serverUserId = null) to all users', async () => {
      const serverUserId = 'user-123';
      const session = createMockSession({ serverUserId, state: 'playing' });

      // Global rule (serverUserId = null)
      const rule = createMockRule('concurrent_streams', {
        serverUserId: null,
        params: { maxStreams: 0 }, // Any stream violates
      });

      const results = await ruleEngine.evaluateSession(session, [rule], []);
      expect(results).toHaveLength(1);
      expect(results[0]!.violated).toBe(true);
    });

    it('should apply user-specific rules to matching users', async () => {
      const serverUserId = 'user-123';
      const session = createMockSession({ serverUserId, state: 'playing' });

      // User-specific rule
      const rule = createMockRule('concurrent_streams', {
        serverUserId,
        params: { maxStreams: 0 }, // Any stream violates
      });

      const results = await ruleEngine.evaluateSession(session, [rule], []);
      expect(results).toHaveLength(1);
      expect(results[0]!.violated).toBe(true);
    });

    it('should return multiple violations if multiple rules trigger', async () => {
      const serverUserId = 'user-123';
      const session = createMockSession({
        serverUserId,
        state: 'playing',
        geoCountry: 'CN',
      });

      const rules = [
        createMockRule('concurrent_streams', {
          params: { maxStreams: 0 },
        }),
        createMockRule('geo_restriction', {
          params: { mode: 'blocklist', countries: ['CN'] },
        }),
      ];

      const results = await ruleEngine.evaluateSession(session, rules, []);
      expect(results).toHaveLength(2);
    });
  });

  describe('impossible_travel', () => {
    const serverUserId = 'user-123';

    it('should not violate when speed is within limit', async () => {
      // NYC to LA is ~3,944 km
      // If 10 hours passed, speed = 394.4 km/h (within 500 km/h limit)
      const previousSession = createMockSession({
        serverUserId,
        geoLat: TEST_LOCATIONS.newYork.lat,
        geoLon: TEST_LOCATIONS.newYork.lon,
        startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000), // 10 hours ago
      });

      const currentSession = createMockSession({
        serverUserId,
        geoLat: TEST_LOCATIONS.losAngeles.lat,
        geoLon: TEST_LOCATIONS.losAngeles.lon,
        startedAt: new Date(),
      });

      const rule = createMockRule('impossible_travel', {
        params: { maxSpeedKmh: 500 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [previousSession]);

      expect(results).toHaveLength(0);
    });

    it('should violate when speed exceeds limit', async () => {
      // NYC to London is ~5,570 km
      // If 2 hours passed, speed = 2,785 km/h (exceeds 500 km/h limit)
      const previousSession = createMockSession({
        serverUserId,
        geoLat: TEST_LOCATIONS.newYork.lat,
        geoLon: TEST_LOCATIONS.newYork.lon,
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
      });

      const currentSession = createMockSession({
        serverUserId,
        geoLat: TEST_LOCATIONS.london.lat,
        geoLon: TEST_LOCATIONS.london.lon,
        startedAt: new Date(),
      });

      const rule = createMockRule('impossible_travel', {
        params: { maxSpeedKmh: 500 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [previousSession]);

      expect(results).toHaveLength(1);
      expect(results[0]!.violated).toBe(true);
      expect(results[0]!.severity).toBe('high');
      expect(results[0]!.data).toMatchObject({
        previousLocation: {
          lat: TEST_LOCATIONS.newYork.lat,
          lon: TEST_LOCATIONS.newYork.lon,
        },
        currentLocation: {
          lat: TEST_LOCATIONS.london.lat,
          lon: TEST_LOCATIONS.london.lon,
        },
        maxAllowedSpeed: 500,
      });
      expect(results[0]!.data.calculatedSpeed).toBeGreaterThan(500);
    });

    it('should not violate when geo data is missing on current session', async () => {
      const previousSession = createMockSession({
        serverUserId,
        geoLat: TEST_LOCATIONS.newYork.lat,
        geoLon: TEST_LOCATIONS.newYork.lon,
      });

      const currentSession = createMockSession({
        serverUserId,
        geoLat: null,
        geoLon: null,
      });

      const rule = createMockRule('impossible_travel', {
        params: { maxSpeedKmh: 500 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [previousSession]);

      expect(results).toHaveLength(0);
    });

    it('should not violate when geo data is missing on previous session', async () => {
      const previousSession = createMockSession({
        serverUserId,
        geoLat: null,
        geoLon: null,
      });

      const currentSession = createMockSession({
        serverUserId,
        geoLat: TEST_LOCATIONS.london.lat,
        geoLon: TEST_LOCATIONS.london.lon,
      });

      const rule = createMockRule('impossible_travel', {
        params: { maxSpeedKmh: 500 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [previousSession]);

      expect(results).toHaveLength(0);
    });

    it('should not violate when time difference is zero or negative', async () => {
      const now = new Date();
      const previousSession = createMockSession({
        serverUserId,
        geoLat: TEST_LOCATIONS.newYork.lat,
        geoLon: TEST_LOCATIONS.newYork.lon,
        startedAt: now,
      });

      const currentSession = createMockSession({
        serverUserId,
        geoLat: TEST_LOCATIONS.london.lat,
        geoLon: TEST_LOCATIONS.london.lon,
        startedAt: now, // Same time
      });

      const rule = createMockRule('impossible_travel', {
        params: { maxSpeedKmh: 500 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [previousSession]);

      expect(results).toHaveLength(0);
    });

    it('should check all recent sessions and find any violation', async () => {
      // First session: Old, valid travel
      const oldSession = createMockSession({
        serverUserId,
        geoLat: TEST_LOCATIONS.newYork.lat,
        geoLon: TEST_LOCATIONS.newYork.lon,
        startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 hours ago
      });

      // Second session: Recent, impossible travel from previous
      const recentSession = createMockSession({
        serverUserId,
        geoLat: TEST_LOCATIONS.losAngeles.lat,
        geoLon: TEST_LOCATIONS.losAngeles.lon,
        startedAt: new Date(Date.now() - 30 * 60 * 1000), // 30 minutes ago
      });

      // Current session: Tokyo (impossible from LA in 30 min)
      const currentSession = createMockSession({
        serverUserId,
        geoLat: TEST_LOCATIONS.tokyo.lat,
        geoLon: TEST_LOCATIONS.tokyo.lon,
        startedAt: new Date(),
      });

      const rule = createMockRule('impossible_travel', {
        params: { maxSpeedKmh: 500 },
      });

      const results = await ruleEngine.evaluateSession(
        currentSession,
        [rule],
        [oldSession, recentSession]
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.violated).toBe(true);
    });

    it('should calculate distance correctly between known points', () => {
      // NYC to LA is approximately 3,944 km
      const distance = calculateDistanceKm(
        TEST_LOCATIONS.newYork.lat,
        TEST_LOCATIONS.newYork.lon,
        TEST_LOCATIONS.losAngeles.lat,
        TEST_LOCATIONS.losAngeles.lon
      );
      expect(distance).toBeGreaterThan(3900);
      expect(distance).toBeLessThan(4000);
    });
  });

  describe('simultaneous_locations', () => {
    const serverUserId = 'user-123';

    it('should not violate when distance is within limit', async () => {
      // Two locations very close together (same city)
      const activeSession = createMockSession({
        serverUserId,
        state: 'playing',
        geoLat: TEST_LOCATIONS.newYork.lat,
        geoLon: TEST_LOCATIONS.newYork.lon,
      });

      const currentSession = createMockSession({
        serverUserId,
        state: 'playing',
        geoLat: TEST_LOCATIONS.newYork.lat + 0.01, // Very close
        geoLon: TEST_LOCATIONS.newYork.lon + 0.01,
      });

      const rule = createMockRule('simultaneous_locations', {
        params: { minDistanceKm: 100 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [activeSession]);

      expect(results).toHaveLength(0);
    });

    it('should violate when distance exceeds limit', async () => {
      // NYC to LA (~3,944 km)
      const activeSession = createMockSession({
        serverUserId,
        state: 'playing',
        geoLat: TEST_LOCATIONS.newYork.lat,
        geoLon: TEST_LOCATIONS.newYork.lon,
      });

      const currentSession = createMockSession({
        serverUserId,
        state: 'playing',
        geoLat: TEST_LOCATIONS.losAngeles.lat,
        geoLon: TEST_LOCATIONS.losAngeles.lon,
      });

      const rule = createMockRule('simultaneous_locations', {
        params: { minDistanceKm: 100 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [activeSession]);

      expect(results).toHaveLength(1);
      expect(results[0]!.violated).toBe(true);
      expect(results[0]!.severity).toBe('warning');
      expect(results[0]!.data).toMatchObject({
        minRequiredDistance: 100,
      });
      expect(results[0]!.data.distance).toBeGreaterThan(100);
    });

    it('should ignore non-playing sessions', async () => {
      // Paused session should be ignored
      const pausedSession = createMockSession({
        serverUserId,
        state: 'paused',
        geoLat: TEST_LOCATIONS.london.lat,
        geoLon: TEST_LOCATIONS.london.lon,
      });

      const currentSession = createMockSession({
        serverUserId,
        state: 'playing',
        geoLat: TEST_LOCATIONS.newYork.lat,
        geoLon: TEST_LOCATIONS.newYork.lon,
      });

      const rule = createMockRule('simultaneous_locations', {
        params: { minDistanceKm: 100 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [pausedSession]);

      expect(results).toHaveLength(0);
    });

    it('should ignore stopped sessions', async () => {
      const stoppedSession = createMockSession({
        serverUserId,
        state: 'stopped',
        geoLat: TEST_LOCATIONS.tokyo.lat,
        geoLon: TEST_LOCATIONS.tokyo.lon,
      });

      const currentSession = createMockSession({
        serverUserId,
        state: 'playing',
        geoLat: TEST_LOCATIONS.newYork.lat,
        geoLon: TEST_LOCATIONS.newYork.lon,
      });

      const rule = createMockRule('simultaneous_locations', {
        params: { minDistanceKm: 100 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [stoppedSession]);

      expect(results).toHaveLength(0);
    });

    it('should not violate when geo data is missing', async () => {
      const activeSession = createMockSession({
        serverUserId,
        state: 'playing',
        geoLat: null,
        geoLon: null,
      });

      const currentSession = createMockSession({
        serverUserId,
        state: 'playing',
        geoLat: TEST_LOCATIONS.newYork.lat,
        geoLon: TEST_LOCATIONS.newYork.lon,
      });

      const rule = createMockRule('simultaneous_locations', {
        params: { minDistanceKm: 100 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [activeSession]);

      expect(results).toHaveLength(0);
    });

    it('should ignore sessions from different users', async () => {
      const otherUserSession = createMockSession({
        serverUserId: 'other-user',
        state: 'playing',
        geoLat: TEST_LOCATIONS.tokyo.lat,
        geoLon: TEST_LOCATIONS.tokyo.lon,
      });

      const currentSession = createMockSession({
        serverUserId,
        state: 'playing',
        geoLat: TEST_LOCATIONS.newYork.lat,
        geoLon: TEST_LOCATIONS.newYork.lon,
      });

      const rule = createMockRule('simultaneous_locations', {
        params: { minDistanceKm: 100 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [otherUserSession]);

      expect(results).toHaveLength(0);
    });

    it('should exclude sessions from the same device (likely stale session data)', async () => {
      const sharedDeviceId = 'device-shared-123';

      // Session from same device at different location (stale data)
      const activeSession = createMockSession({
        serverUserId,
        state: 'playing',
        deviceId: sharedDeviceId,
        geoLat: TEST_LOCATIONS.tokyo.lat,
        geoLon: TEST_LOCATIONS.tokyo.lon,
      });

      const currentSession = createMockSession({
        serverUserId,
        state: 'playing',
        deviceId: sharedDeviceId, // Same device
        geoLat: TEST_LOCATIONS.newYork.lat,
        geoLon: TEST_LOCATIONS.newYork.lon,
      });

      const rule = createMockRule('simultaneous_locations', {
        params: { minDistanceKm: 100 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [activeSession]);

      // Should not violate - same device can't be in two places
      expect(results).toHaveLength(0);
    });

    it('should still violate when different devices are in different locations', async () => {
      const activeSession = createMockSession({
        serverUserId,
        state: 'playing',
        deviceId: 'device-123',
        geoLat: TEST_LOCATIONS.tokyo.lat,
        geoLon: TEST_LOCATIONS.tokyo.lon,
      });

      const currentSession = createMockSession({
        serverUserId,
        state: 'playing',
        deviceId: 'device-456', // Different device
        geoLat: TEST_LOCATIONS.newYork.lat,
        geoLon: TEST_LOCATIONS.newYork.lon,
      });

      const rule = createMockRule('simultaneous_locations', {
        params: { minDistanceKm: 100 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [activeSession]);

      // Should violate - different devices in distant locations
      expect(results).toHaveLength(1);
      expect(results[0]!.violated).toBe(true);
    });

    it('should not exclude when deviceId is null on either session', async () => {
      const activeSession = createMockSession({
        serverUserId,
        state: 'playing',
        deviceId: null, // No device ID
        geoLat: TEST_LOCATIONS.tokyo.lat,
        geoLon: TEST_LOCATIONS.tokyo.lon,
      });

      const currentSession = createMockSession({
        serverUserId,
        state: 'playing',
        deviceId: 'device-123',
        geoLat: TEST_LOCATIONS.newYork.lat,
        geoLon: TEST_LOCATIONS.newYork.lon,
      });

      const rule = createMockRule('simultaneous_locations', {
        params: { minDistanceKm: 100 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [activeSession]);

      // Should violate - can't determine if same device when deviceId is null
      expect(results).toHaveLength(1);
      expect(results[0]!.violated).toBe(true);
    });

    it('should include relatedSessionIds in violation data', async () => {
      const activeSessions = [
        createMockSession({
          id: 'session-la',
          serverUserId,
          state: 'playing',
          deviceId: 'device-1',
          geoLat: TEST_LOCATIONS.losAngeles.lat,
          geoLon: TEST_LOCATIONS.losAngeles.lon,
        }),
        createMockSession({
          id: 'session-tokyo',
          serverUserId,
          state: 'playing',
          deviceId: 'device-2',
          geoLat: TEST_LOCATIONS.tokyo.lat,
          geoLon: TEST_LOCATIONS.tokyo.lon,
        }),
      ];

      const currentSession = createMockSession({
        id: 'session-ny',
        serverUserId,
        state: 'playing',
        deviceId: 'device-3',
        geoLat: TEST_LOCATIONS.newYork.lat,
        geoLon: TEST_LOCATIONS.newYork.lon,
      });

      const rule = createMockRule('simultaneous_locations', {
        params: { minDistanceKm: 100 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], activeSessions);

      expect(results).toHaveLength(1);
      expect(results[0]!.data.relatedSessionIds).toContain('session-la');
      expect(results[0]!.data.relatedSessionIds).toContain('session-tokyo');
    });
  });

  describe('device_velocity', () => {
    const serverUserId = 'user-123';

    it('should not violate when unique IPs are within limit', async () => {
      const sessions = createSessionsWithDifferentIps(serverUserId, 3, 24);
      const currentSession = createMockSession({
        serverUserId,
        ipAddress: '192.168.1.200', // 4th unique IP
      });

      const rule = createMockRule('device_velocity', {
        params: { maxIps: 5, windowHours: 24 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], sessions);

      expect(results).toHaveLength(0);
    });

    it('should violate when unique IPs exceed limit', async () => {
      const sessions = createSessionsWithDifferentIps(serverUserId, 5, 24);
      const currentSession = createMockSession({
        serverUserId,
        ipAddress: '192.168.1.200', // 6th unique IP
      });

      const rule = createMockRule('device_velocity', {
        params: { maxIps: 5, windowHours: 24 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], sessions);

      expect(results).toHaveLength(1);
      expect(results[0]!.violated).toBe(true);
      expect(results[0]!.severity).toBe('warning');
      expect(results[0]!.data.uniqueIpCount).toBe(6);
      expect(results[0]!.data.maxAllowedIps).toBe(5);
      expect(results[0]!.data.windowHours).toBe(24);
    });

    it('should include current session IP in count', async () => {
      // 4 unique IPs from previous sessions + 1 from current = 5 (at limit)
      const sessions = createSessionsWithDifferentIps(serverUserId, 4, 24);
      const currentSession = createMockSession({
        serverUserId,
        ipAddress: '192.168.1.200', // 5th unique IP
      });

      const rule = createMockRule('device_velocity', {
        params: { maxIps: 5, windowHours: 24 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], sessions);

      expect(results).toHaveLength(0); // Exactly at limit, not over
    });

    it('should respect time window', async () => {
      // Sessions outside the window should be ignored
      const oldSessions = [
        createMockSession({
          serverUserId,
          ipAddress: '192.168.1.1',
          startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // 48 hours ago
        }),
        createMockSession({
          serverUserId,
          ipAddress: '192.168.1.2',
          startedAt: new Date(Date.now() - 36 * 60 * 60 * 1000), // 36 hours ago
        }),
      ];

      const currentSession = createMockSession({
        serverUserId,
        ipAddress: '192.168.1.3',
      });

      const rule = createMockRule('device_velocity', {
        params: { maxIps: 2, windowHours: 24 }, // 24-hour window
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], oldSessions);

      // Old sessions are outside window, only current session IP counts
      expect(results).toHaveLength(0);
    });

    it('should count sessions within window correctly', async () => {
      const windowHours = 24;
      const sessionsInWindow = [
        createMockSession({
          serverUserId,
          ipAddress: '192.168.1.1',
          startedAt: new Date(Date.now() - 23 * 60 * 60 * 1000), // 23 hours ago (in window)
        }),
        createMockSession({
          serverUserId,
          ipAddress: '192.168.1.2',
          startedAt: new Date(Date.now() - 12 * 60 * 60 * 1000), // 12 hours ago
        }),
      ];

      const currentSession = createMockSession({
        serverUserId,
        ipAddress: '192.168.1.3', // 3rd unique IP
        startedAt: new Date(),
      });

      const rule = createMockRule('device_velocity', {
        params: { maxIps: 2, windowHours },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], sessionsInWindow);

      expect(results).toHaveLength(1);
      expect(results[0]!.data.uniqueIpCount).toBe(3);
    });

    it('should not double-count duplicate IPs', async () => {
      // Multiple sessions from same IP should count as 1
      const sessions = [
        createMockSession({ serverUserId, ipAddress: '192.168.1.1' }),
        createMockSession({ serverUserId, ipAddress: '192.168.1.1' }), // Same IP
        createMockSession({ serverUserId, ipAddress: '192.168.1.2' }),
      ];

      const currentSession = createMockSession({
        serverUserId,
        ipAddress: '192.168.1.1', // Same IP again
      });

      const rule = createMockRule('device_velocity', {
        params: { maxIps: 2, windowHours: 24 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], sessions);

      // Only 2 unique IPs: 192.168.1.1 and 192.168.1.2
      expect(results).toHaveLength(0);
    });
  });

  describe('concurrent_streams', () => {
    const serverUserId = 'user-123';

    it('should not violate when streams are within limit', async () => {
      const activeSessions = [
        createMockSession({ serverUserId, state: 'playing' }),
        createMockSession({ serverUserId, state: 'playing' }),
      ];

      const currentSession = createMockSession({ serverUserId, state: 'playing' });

      const rule = createMockRule('concurrent_streams', {
        params: { maxStreams: 3 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], activeSessions);

      // 2 existing + 1 current = 3 (at limit)
      expect(results).toHaveLength(0);
    });

    it('should violate when streams exceed limit', async () => {
      const activeSessions = [
        createMockSession({ serverUserId, state: 'playing' }),
        createMockSession({ serverUserId, state: 'playing' }),
        createMockSession({ serverUserId, state: 'playing' }),
      ];

      const currentSession = createMockSession({ serverUserId, state: 'playing' });

      const rule = createMockRule('concurrent_streams', {
        params: { maxStreams: 3 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], activeSessions);

      // 3 existing + 1 current = 4 (exceeds limit of 3)
      expect(results).toHaveLength(1);
      expect(results[0]!.violated).toBe(true);
      expect(results[0]!.severity).toBe('low');
      expect(results[0]!.data).toMatchObject({
        activeStreamCount: 4,
        maxAllowedStreams: 3,
      });
    });

    it('should only count playing sessions', async () => {
      const sessions = [
        createMockSession({ serverUserId, state: 'playing' }),
        createMockSession({ serverUserId, state: 'paused' }), // Should not count
        createMockSession({ serverUserId, state: 'stopped' }), // Should not count
      ];

      const currentSession = createMockSession({ serverUserId, state: 'playing' });

      const rule = createMockRule('concurrent_streams', {
        params: { maxStreams: 1 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], sessions);

      // Only 1 playing + 1 current = 2, exceeds limit of 1
      expect(results).toHaveLength(1);
      expect(results[0]!.data.activeStreamCount).toBe(2);
    });

    it('should include current session in count', async () => {
      // No existing sessions, just current
      const currentSession = createMockSession({ serverUserId, state: 'playing' });

      const rule = createMockRule('concurrent_streams', {
        params: { maxStreams: 0 }, // Zero tolerance
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], []);

      // Current session counts as 1
      expect(results).toHaveLength(1);
      expect(results[0]!.data.activeStreamCount).toBe(1);
    });

    it('should ignore sessions from different users', async () => {
      const otherUserSessions = [
        createMockSession({ serverUserId: 'other-user-1', state: 'playing' }),
        createMockSession({ serverUserId: 'other-user-2', state: 'playing' }),
      ];

      const currentSession = createMockSession({ serverUserId, state: 'playing' });

      const rule = createMockRule('concurrent_streams', {
        params: { maxStreams: 1 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], otherUserSessions);

      // Only current session counts for this user
      expect(results).toHaveLength(0);
    });

    it('should exclude sessions from the same device (reconnects/stale sessions)', async () => {
      const sharedDeviceId = 'device-shared-123';

      // Two sessions from same device - should be treated as one stream
      const activeSessions = [
        createMockSession({ serverUserId, state: 'playing', deviceId: sharedDeviceId }),
        createMockSession({ serverUserId, state: 'playing', deviceId: 'device-other-456' }),
      ];

      const currentSession = createMockSession({
        serverUserId,
        state: 'playing',
        deviceId: sharedDeviceId, // Same device as first active session
      });

      const rule = createMockRule('concurrent_streams', {
        params: { maxStreams: 2 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], activeSessions);

      // Should only count 2 streams: current session + device-other-456
      // The device-shared-123 session should be excluded (same device as current)
      expect(results).toHaveLength(0);
    });

    it('should not exclude sessions when deviceId is null on current session', async () => {
      const activeSessions = [
        createMockSession({ serverUserId, state: 'playing', deviceId: 'device-123' }),
        createMockSession({ serverUserId, state: 'playing', deviceId: 'device-456' }),
      ];

      const currentSession = createMockSession({
        serverUserId,
        state: 'playing',
        deviceId: null, // No device ID
      });

      const rule = createMockRule('concurrent_streams', {
        params: { maxStreams: 2 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], activeSessions);

      // Should count all 3 streams since we can't determine device identity
      expect(results).toHaveLength(1);
      expect(results[0]!.data.activeStreamCount).toBe(3);
    });

    it('should not exclude sessions when deviceId is null on active session', async () => {
      const activeSessions = [
        createMockSession({ serverUserId, state: 'playing', deviceId: null }), // No device ID
        createMockSession({ serverUserId, state: 'playing', deviceId: 'device-456' }),
      ];

      const currentSession = createMockSession({
        serverUserId,
        state: 'playing',
        deviceId: 'device-123',
      });

      const rule = createMockRule('concurrent_streams', {
        params: { maxStreams: 2 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], activeSessions);

      // Should count all 3 streams since null deviceId can't be matched
      expect(results).toHaveLength(1);
      expect(results[0]!.data.activeStreamCount).toBe(3);
    });

    it('should include relatedSessionIds in violation data', async () => {
      const activeSessions = [
        createMockSession({
          id: 'session-1',
          serverUserId,
          state: 'playing',
          deviceId: 'device-1',
        }),
        createMockSession({
          id: 'session-2',
          serverUserId,
          state: 'playing',
          deviceId: 'device-2',
        }),
      ];

      const currentSession = createMockSession({
        id: 'session-current',
        serverUserId,
        state: 'playing',
        deviceId: 'device-current',
      });

      const rule = createMockRule('concurrent_streams', {
        params: { maxStreams: 2 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], activeSessions);

      expect(results).toHaveLength(1);
      expect(results[0]!.data.relatedSessionIds).toEqual(['session-1', 'session-2']);
    });
  });

  describe('geo_restriction', () => {
    it('should not violate when country is not blocked', async () => {
      const session = createMockSession({
        geoCountry: 'US',
      });

      const rule = createMockRule('geo_restriction', {
        params: { mode: 'blocklist', countries: ['CN', 'RU', 'KP'] },
      });

      const results = await ruleEngine.evaluateSession(session, [rule], []);
      expect(results).toHaveLength(0);
    });

    it('should violate when country is blocked', async () => {
      const session = createMockSession({
        geoCountry: 'CN',
      });

      const rule = createMockRule('geo_restriction', {
        params: { mode: 'blocklist', countries: ['CN', 'RU', 'KP'] },
      });

      const results = await ruleEngine.evaluateSession(session, [rule], []);

      expect(results).toHaveLength(1);
      expect(results[0]!.violated).toBe(true);
      expect(results[0]!.severity).toBe('high');
      expect(results[0]!.data).toMatchObject({
        country: 'CN',
        mode: 'blocklist',
        countries: ['CN', 'RU', 'KP'],
      });
    });

    it('should not violate when geoCountry is null', async () => {
      const session = createMockSession({
        geoCountry: null,
      });

      const rule = createMockRule('geo_restriction', {
        params: { mode: 'blocklist', countries: ['CN', 'RU'] },
      });

      const results = await ruleEngine.evaluateSession(session, [rule], []);
      expect(results).toHaveLength(0);
    });

    it('should not violate when countries list is empty', async () => {
      const session = createMockSession({
        geoCountry: 'CN',
      });

      const rule = createMockRule('geo_restriction', {
        params: { mode: 'blocklist', countries: [] },
      });

      const results = await ruleEngine.evaluateSession(session, [rule], []);
      expect(results).toHaveLength(0);
    });

    it('should be case-sensitive for country codes', async () => {
      // Country codes should be uppercase
      const session = createMockSession({
        geoCountry: 'cn', // lowercase
      });

      const rule = createMockRule('geo_restriction', {
        params: { mode: 'blocklist', countries: ['CN'] }, // uppercase
      });

      const results = await ruleEngine.evaluateSession(session, [rule], []);

      // Case-sensitive, so 'cn' !== 'CN'
      expect(results).toHaveLength(0);
    });

    it('should violate for any blocked country in list', async () => {
      const session = createMockSession({
        geoCountry: 'KP', // Last in the list
      });

      const rule = createMockRule('geo_restriction', {
        params: { mode: 'blocklist', countries: ['CN', 'RU', 'KP'] },
      });

      const results = await ruleEngine.evaluateSession(session, [rule], []);
      expect(results).toHaveLength(1);
      expect(results[0]!.data.country).toBe('KP');
    });

    it('should violate in allowlist mode when country is NOT in allowed list', async () => {
      const session = createMockSession({
        geoCountry: 'CN',
      });

      const rule = createMockRule('geo_restriction', {
        params: { mode: 'allowlist', countries: ['US', 'CA', 'GB'] },
      });

      const results = await ruleEngine.evaluateSession(session, [rule], []);
      expect(results).toHaveLength(1);
      expect(results[0]!.violated).toBe(true);
      expect(results[0]!.data).toMatchObject({
        country: 'CN',
        mode: 'allowlist',
        countries: ['US', 'CA', 'GB'],
      });
    });

    it('should NOT violate in allowlist mode when country IS in allowed list', async () => {
      const session = createMockSession({
        geoCountry: 'US',
      });

      const rule = createMockRule('geo_restriction', {
        params: { mode: 'allowlist', countries: ['US', 'CA', 'GB'] },
      });

      const results = await ruleEngine.evaluateSession(session, [rule], []);
      expect(results).toHaveLength(0);
    });
  });

  describe('unknown rule type', () => {
    it('should return no violation for unknown rule type', async () => {
      const session = createMockSession();
      const rule = {
        ...createMockRule('concurrent_streams'),
        type: 'unknown_type' as any,
      };

      const results = await ruleEngine.evaluateSession(session, [rule], []);
      expect(results).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty recent sessions array', async () => {
      const session = createMockSession();
      const rules = [
        createMockRule('impossible_travel'),
        createMockRule('simultaneous_locations'),
        createMockRule('device_velocity'),
        createMockRule('concurrent_streams'),
        createMockRule('geo_restriction', {
          params: { mode: 'blocklist', countries: ['CN'] },
        }),
      ];

      const results = await ruleEngine.evaluateSession(session, rules, []);

      // Only concurrent_streams should trigger (1 stream when maxStreams defaults to 3)
      // geo_restriction shouldn't trigger because session is US
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('should handle session at exactly the boundary', async () => {
      const serverUserId = 'user-123';

      // Exactly at the maxStreams limit
      const activeSessions = [createMockSession({ serverUserId, state: 'playing' })];

      const currentSession = createMockSession({ serverUserId, state: 'playing' });

      const rule = createMockRule('concurrent_streams', {
        params: { maxStreams: 2 }, // 1 + 1 = 2, exactly at limit
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], activeSessions);

      expect(results).toHaveLength(0); // At limit, not over
    });

    it('should handle very large distances correctly', async () => {
      const serverUserId = 'user-123';
      // Antipodal points (opposite sides of Earth)
      const previousSession = createMockSession({
        serverUserId,
        geoLat: 0,
        geoLon: 0,
        startedAt: new Date(Date.now() - 1 * 60 * 60 * 1000), // 1 hour ago
      });

      const currentSession = createMockSession({
        serverUserId,
        geoLat: 0,
        geoLon: 180, // Opposite side of Earth
        startedAt: new Date(),
      });

      const rule = createMockRule('impossible_travel', {
        params: { maxSpeedKmh: 500 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [previousSession]);

      expect(results).toHaveLength(1);
      // Earth's circumference at equator is ~40,075 km, half is ~20,000 km
      // Speed would be ~20,000 km/h
      expect(results[0]!.data.calculatedSpeed).toBeGreaterThan(15000);
    });
  });
});
