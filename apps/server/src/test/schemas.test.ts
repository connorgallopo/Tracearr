/**
 * Zod schema validation tests for rule parameters and violations
 *
 * Tests validation behavior for:
 * - Rule parameter schemas for all 5 rule types
 * - Violation query schema
 */

import { describe, it, expect } from 'vitest';
import {
  impossibleTravelParamsSchema,
  simultaneousLocationsParamsSchema,
  deviceVelocityParamsSchema,
  concurrentStreamsParamsSchema,
  geoRestrictionParamsSchema,
  violationQuerySchema,
  violationIdParamSchema,
  terminateSessionBodySchema,
  updateSettingsSchema,
  updateUserIdentitySchema,
} from '@tracearr/shared';
import { randomUUID } from 'node:crypto';

describe('Rule Parameter Schemas', () => {
  describe('impossibleTravelParamsSchema', () => {
    it('should validate with custom maxSpeedKmh', () => {
      const result = impossibleTravelParamsSchema.safeParse({
        maxSpeedKmh: 1000,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxSpeedKmh).toBe(1000);
      }
    });

    it('should apply default maxSpeedKmh', () => {
      const result = impossibleTravelParamsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxSpeedKmh).toBe(500);
        expect(result.data.skipMobileSameCountry).toBe(true);
      }
    });

    it('should accept ignoreVpnRanges', () => {
      const result = impossibleTravelParamsSchema.safeParse({
        maxSpeedKmh: 500,
        ignoreVpnRanges: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ignoreVpnRanges).toBe(true);
      }
    });

    it('should reject non-positive maxSpeedKmh', () => {
      const invalidValues = [0, -100];
      for (const val of invalidValues) {
        const result = impossibleTravelParamsSchema.safeParse({
          maxSpeedKmh: val,
        });
        expect(result.success).toBe(false);
      }
    });
  });

  describe('simultaneousLocationsParamsSchema', () => {
    it('should validate with custom minDistanceKm', () => {
      const result = simultaneousLocationsParamsSchema.safeParse({
        minDistanceKm: 200,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.minDistanceKm).toBe(200);
      }
    });

    it('should apply default minDistanceKm', () => {
      const result = simultaneousLocationsParamsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.minDistanceKm).toBe(100);
      }
    });

    it('should reject non-positive minDistanceKm', () => {
      const result = simultaneousLocationsParamsSchema.safeParse({
        minDistanceKm: 0,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('deviceVelocityParamsSchema', () => {
    it('should validate with custom values', () => {
      const result = deviceVelocityParamsSchema.safeParse({
        maxIps: 10,
        windowHours: 48,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxIps).toBe(10);
        expect(result.data.windowHours).toBe(48);
      }
    });

    it('should apply defaults', () => {
      const result = deviceVelocityParamsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxIps).toBe(5);
        expect(result.data.windowHours).toBe(24);
      }
    });

    it('should reject non-positive maxIps', () => {
      const result = deviceVelocityParamsSchema.safeParse({
        maxIps: 0,
        windowHours: 24,
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-positive windowHours', () => {
      const result = deviceVelocityParamsSchema.safeParse({
        maxIps: 5,
        windowHours: 0,
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer values', () => {
      const result = deviceVelocityParamsSchema.safeParse({
        maxIps: 5.5,
        windowHours: 24.7,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('concurrentStreamsParamsSchema', () => {
    it('should validate with custom maxStreams', () => {
      const result = concurrentStreamsParamsSchema.safeParse({
        maxStreams: 5,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxStreams).toBe(5);
      }
    });

    it('should apply default maxStreams', () => {
      const result = concurrentStreamsParamsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxStreams).toBe(3);
      }
    });

    it('should reject non-positive maxStreams', () => {
      const result = concurrentStreamsParamsSchema.safeParse({
        maxStreams: 0,
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer maxStreams', () => {
      const result = concurrentStreamsParamsSchema.safeParse({
        maxStreams: 3.5,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('geoRestrictionParamsSchema', () => {
    it('should validate with blocklist mode and countries', () => {
      const result = geoRestrictionParamsSchema.safeParse({
        mode: 'blocklist',
        countries: ['CN', 'RU', 'KP'],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mode).toBe('blocklist');
        expect(result.data.countries).toEqual(['CN', 'RU', 'KP']);
      }
    });

    it('should validate with allowlist mode', () => {
      const result = geoRestrictionParamsSchema.safeParse({
        mode: 'allowlist',
        countries: ['US', 'CA', 'GB'],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mode).toBe('allowlist');
        expect(result.data.countries).toEqual(['US', 'CA', 'GB']);
      }
    });

    it('should apply defaults for empty object', () => {
      const result = geoRestrictionParamsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mode).toBe('blocklist');
        expect(result.data.countries).toEqual([]);
      }
    });

    it('should reject country codes that are not 2 characters', () => {
      const invalidInputs = [
        { mode: 'blocklist', countries: ['USA'] }, // 3 chars
        { mode: 'blocklist', countries: ['C'] }, // 1 char
        { mode: 'blocklist', countries: ['CHINA'] }, // 5 chars
      ];

      for (const input of invalidInputs) {
        const result = geoRestrictionParamsSchema.safeParse(input);
        expect(result.success).toBe(false);
      }
    });

    it('should allow empty countries array', () => {
      const result = geoRestrictionParamsSchema.safeParse({
        mode: 'blocklist',
        countries: [],
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid mode values', () => {
      const result = geoRestrictionParamsSchema.safeParse({
        mode: 'invalid',
        countries: ['US'],
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('Violation Schemas', () => {
  describe('violationQuerySchema', () => {
    it('should validate empty query (defaults)', () => {
      const result = violationQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.pageSize).toBe(20);
      }
    });

    it('should validate pagination params', () => {
      const result = violationQuerySchema.safeParse({
        page: 5,
        pageSize: 50,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(5);
        expect(result.data.pageSize).toBe(50);
      }
    });

    it('should coerce string numbers', () => {
      const result = violationQuerySchema.safeParse({
        page: '3',
        pageSize: '25',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(3);
        expect(result.data.pageSize).toBe(25);
      }
    });

    it('should validate serverUserId filter', () => {
      const serverUserId = randomUUID();
      const result = violationQuerySchema.safeParse({ serverUserId });
      expect(result.success).toBe(true);
    });

    it('should validate ruleId filter', () => {
      const ruleId = randomUUID();
      const result = violationQuerySchema.safeParse({ ruleId });
      expect(result.success).toBe(true);
    });

    it('should validate severity filter', () => {
      const severities = ['low', 'warning', 'high'];
      for (const severity of severities) {
        const result = violationQuerySchema.safeParse({ severity });
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid severity', () => {
      const result = violationQuerySchema.safeParse({
        severity: 'critical',
      });
      expect(result.success).toBe(false);
    });

    it('should validate acknowledged filter', () => {
      const results = [
        violationQuerySchema.safeParse({ acknowledged: true }),
        violationQuerySchema.safeParse({ acknowledged: false }),
        violationQuerySchema.safeParse({ acknowledged: 'true' }), // coercion
        violationQuerySchema.safeParse({ acknowledged: 'false' }), // coercion
      ];

      for (const result of results) {
        expect(result.success).toBe(true);
      }
    });

    it('should validate date filters as calendar days', () => {
      const result = violationQuerySchema.safeParse({
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        // Calendar days, not instants: the route resolves them to half-open UTC
        // bounds so endDate includes the day it names.
        expect(result.data.startDate).toBe('2024-01-01');
        expect(result.data.endDate).toBe('2024-12-31');
      }
    });

    it('should reject a datetime where a calendar day is expected', () => {
      const result = violationQuerySchema.safeParse({ startDate: '2024-01-01T10:00:00Z' });
      expect(result.success).toBe(false);
    });

    it('should reject pageSize over 100', () => {
      const result = violationQuerySchema.safeParse({
        pageSize: 101,
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-positive page', () => {
      const result = violationQuerySchema.safeParse({
        page: 0,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('violationIdParamSchema', () => {
    it('should validate valid UUID', () => {
      const result = violationIdParamSchema.safeParse({ id: randomUUID() });
      expect(result.success).toBe(true);
    });

    it('should reject invalid UUID', () => {
      const result = violationIdParamSchema.safeParse({ id: 'invalid' });
      expect(result.success).toBe(false);
    });
  });
});

describe('Session Termination Schemas', () => {
  describe('terminateSessionBodySchema', () => {
    it('should validate empty body (no reason)', () => {
      const result = terminateSessionBodySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.reason).toBeUndefined();
      }
    });

    describe('Membership schemas', () => {
      it('accepts account type, expiry, and policy fields for identities only', () => {
        expect(
          updateUserIdentitySchema.safeParse({
            membershipType: 'normal',
            membershipExpirationDate: '2026-12-31',
            membershipEnforcementPolicy: 'kill_every_2_plays',
          }).success
        ).toBe(true);
        expect(updateUserIdentitySchema.safeParse({ membershipStatus: 'paid' }).success).toBe(
          false
        );
      });

      it('rejects invalid identity membership enums and dates', () => {
        expect(
          updateUserIdentitySchema.safeParse({ membershipExpirationDate: 'not-a-date' }).success
        ).toBe(false);
      });
    });

    it('should validate body with reason', () => {
      const result = terminateSessionBodySchema.safeParse({
        reason: 'Concurrent stream limit exceeded',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.reason).toBe('Concurrent stream limit exceeded');
      }
    });

    it('should accept reason up to 500 characters', () => {
      const longReason = 'a'.repeat(500);
      const result = terminateSessionBodySchema.safeParse({
        reason: longReason,
      });
      expect(result.success).toBe(true);
    });

    it('should reject reason over 500 characters', () => {
      const tooLongReason = 'a'.repeat(501);
      const result = terminateSessionBodySchema.safeParse({
        reason: tooLongReason,
      });
      expect(result.success).toBe(false);
    });

    it('should accept undefined reason', () => {
      const result = terminateSessionBodySchema.safeParse({
        reason: undefined,
      });
      expect(result.success).toBe(true);
    });
  });
});
