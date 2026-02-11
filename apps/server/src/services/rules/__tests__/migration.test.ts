import { describe, it, expect } from 'vitest';
import { convertLegacyRule, needsMigration, migrateRules, type LegacyRule } from '../migration.js';

describe('Rule Migration', () => {
  describe('needsMigration', () => {
    it('returns true for rule with legacy fields but no V2 fields', () => {
      const rule = {
        type: 'concurrent_streams',
        params: { maxStreams: 3 },
        conditions: null,
        actions: null,
      };
      expect(needsMigration(rule)).toBe(true);
    });

    it('returns false for rule with V2 fields', () => {
      const rule = {
        type: 'concurrent_streams',
        params: { maxStreams: 3 },
        conditions: { groups: [] },
        actions: { actions: [] },
      };
      expect(needsMigration(rule)).toBe(false);
    });

    it('returns false for rule with no legacy fields', () => {
      const rule = {
        type: null,
        params: null,
        conditions: { groups: [] },
        actions: { actions: [] },
      };
      expect(needsMigration(rule)).toBe(false);
    });

    it('returns false for rule with only type but no params', () => {
      const rule = {
        type: 'concurrent_streams',
        params: null,
        conditions: null,
        actions: null,
      };
      expect(needsMigration(rule)).toBe(false);
    });
  });

  describe('convertLegacyRule', () => {
    describe('concurrent_streams', () => {
      it('converts basic concurrent streams rule', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: 'Max 3 streams',
          type: 'concurrent_streams',
          params: { maxStreams: 3 },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result).not.toBeNull();
        expect(result?.conditions.groups).toHaveLength(1);
        expect(result?.conditions.groups[0]?.conditions).toHaveLength(1);
        expect(result?.conditions.groups[0]?.conditions[0]).toEqual({
          field: 'concurrent_streams',
          operator: 'gt',
          value: 3,
        });
        expect(result?.actions.actions).toHaveLength(1);
        expect(result?.actions.actions[0]?.type).toBe('create_violation');
      });

      it('adds is_local_network condition as separate AND group when excludePrivateIps is true', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: 'Max 3 streams (public only)',
          type: 'concurrent_streams',
          params: { maxStreams: 3, excludePrivateIps: true },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        // Should have 2 groups (AND logic between groups)
        expect(result?.conditions.groups).toHaveLength(2);
        // First group: concurrent_streams condition
        expect(result?.conditions.groups[0]?.conditions).toHaveLength(1);
        expect(result?.conditions.groups[0]?.conditions[0]).toEqual({
          field: 'concurrent_streams',
          operator: 'gt',
          value: 3,
        });
        // Second group: is_local_network condition (AND with first group)
        expect(result?.conditions.groups[1]?.conditions).toHaveLength(1);
        expect(result?.conditions.groups[1]?.conditions[0]).toEqual({
          field: 'is_local_network',
          operator: 'eq',
          value: false,
        });
      });
    });

    describe('geo_restriction', () => {
      it('converts blocklist mode', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: 'Block US and CA',
          type: 'geo_restriction',
          params: { mode: 'blocklist', countries: ['US', 'CA'] },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result?.conditions.groups[0]?.conditions[0]).toEqual({
          field: 'country',
          operator: 'in',
          value: ['US', 'CA'],
        });
      });

      it('converts allowlist mode', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: 'Only allow US',
          type: 'geo_restriction',
          params: { mode: 'allowlist', countries: ['US'] },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result?.conditions.groups[0]?.conditions[0]).toEqual({
          field: 'country',
          operator: 'not_in',
          value: ['US'],
        });
      });

      it('adds is_local_network as separate AND group when excludePrivateIps is true', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: 'Block US (public only)',
          type: 'geo_restriction',
          params: { mode: 'blocklist', countries: ['US'], excludePrivateIps: true },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result?.conditions.groups).toHaveLength(2);
        expect(result?.conditions.groups[0]?.conditions[0]).toEqual({
          field: 'country',
          operator: 'in',
          value: ['US'],
        });
        expect(result?.conditions.groups[1]?.conditions[0]).toEqual({
          field: 'is_local_network',
          operator: 'eq',
          value: false,
        });
      });
    });

    describe('impossible_travel', () => {
      it('converts impossible travel rule', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: 'Speed limit 500kmh',
          type: 'impossible_travel',
          params: { maxSpeedKmh: 500 },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result?.conditions.groups[0]?.conditions[0]).toEqual({
          field: 'travel_speed_kmh',
          operator: 'gt',
          value: 500,
        });
      });

      it('adds is_local_network as separate AND group when excludePrivateIps is true', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: 'Speed limit (public only)',
          type: 'impossible_travel',
          params: { maxSpeedKmh: 500, excludePrivateIps: true },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result?.conditions.groups).toHaveLength(2);
        expect(result?.conditions.groups[1]?.conditions[0]).toEqual({
          field: 'is_local_network',
          operator: 'eq',
          value: false,
        });
      });
    });

    describe('simultaneous_locations', () => {
      it('converts simultaneous locations rule', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: 'Min 100km apart',
          type: 'simultaneous_locations',
          params: { minDistanceKm: 100 },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result?.conditions.groups[0]?.conditions[0]).toEqual({
          field: 'active_session_distance_km',
          operator: 'gt',
          value: 100,
        });
      });

      it('adds is_local_network as separate AND group when excludePrivateIps is true', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: 'Min 100km (public only)',
          type: 'simultaneous_locations',
          params: { minDistanceKm: 100, excludePrivateIps: true },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result?.conditions.groups).toHaveLength(2);
        expect(result?.conditions.groups[1]?.conditions[0]).toEqual({
          field: 'is_local_network',
          operator: 'eq',
          value: false,
        });
      });
    });

    describe('device_velocity', () => {
      it('converts device velocity rule with windowHours preserved', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: 'Max 5 IPs',
          type: 'device_velocity',
          params: { maxIps: 5, windowHours: 24 },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result?.conditions.groups[0]?.conditions[0]).toEqual({
          field: 'unique_ips_in_window',
          operator: 'gt',
          value: 5,
          params: {
            window_hours: 24,
          },
        });
      });

      it('preserves custom windowHours value', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: 'Max 10 IPs in 48 hours',
          type: 'device_velocity',
          params: { maxIps: 10, windowHours: 48 },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result?.conditions.groups[0]?.conditions[0]?.params?.window_hours).toBe(48);
      });

      it('adds is_local_network as separate AND group when excludePrivateIps is true', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: 'Max 5 IPs (public only)',
          type: 'device_velocity',
          params: { maxIps: 5, windowHours: 24, excludePrivateIps: true },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result?.conditions.groups).toHaveLength(2);
        expect(result?.conditions.groups[1]?.conditions[0]).toEqual({
          field: 'is_local_network',
          operator: 'eq',
          value: false,
        });
      });

      it('uses unique_devices_in_window when groupByDevice is true', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: 'Max 5 devices',
          type: 'device_velocity',
          params: { maxIps: 5, windowHours: 24, groupByDevice: true },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result?.conditions.groups).toHaveLength(1);
        expect(result?.conditions.groups[0]?.conditions[0]).toEqual({
          field: 'unique_devices_in_window',
          operator: 'gt',
          value: 5,
          params: {
            window_hours: 24,
          },
        });
      });

      it('uses unique_ips_in_window when groupByDevice is false', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: 'Max 5 IPs',
          type: 'device_velocity',
          params: { maxIps: 5, windowHours: 24, groupByDevice: false },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result?.conditions.groups[0]?.conditions[0]?.field).toBe('unique_ips_in_window');
      });

      it('handles groupByDevice with excludePrivateIps (both AND conditions)', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: 'Max 5 devices (public only)',
          type: 'device_velocity',
          params: { maxIps: 5, windowHours: 24, groupByDevice: true, excludePrivateIps: true },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        // Should have 2 groups (AND logic)
        expect(result?.conditions.groups).toHaveLength(2);
        // First group: unique_devices_in_window condition
        expect(result?.conditions.groups[0]?.conditions[0]?.field).toBe('unique_devices_in_window');
        // Second group: is_local_network condition (AND with first)
        expect(result?.conditions.groups[1]?.conditions[0]).toEqual({
          field: 'is_local_network',
          operator: 'eq',
          value: false,
        });
      });
    });

    describe('account_inactivity', () => {
      it('converts days unit', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: '30 days inactive',
          type: 'account_inactivity',
          params: { inactivityValue: 30, inactivityUnit: 'days' },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result?.conditions.groups[0]?.conditions[0]).toEqual({
          field: 'inactive_days',
          operator: 'gt',
          value: 30,
        });
      });

      it('converts weeks to days', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: '2 weeks inactive',
          type: 'account_inactivity',
          params: { inactivityValue: 2, inactivityUnit: 'weeks' },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result?.conditions.groups[0]?.conditions[0]).toEqual({
          field: 'inactive_days',
          operator: 'gt',
          value: 14,
        });
      });

      it('converts months to days', () => {
        const legacyRule: LegacyRule = {
          id: 'rule-1',
          name: '3 months inactive',
          type: 'account_inactivity',
          params: { inactivityValue: 3, inactivityUnit: 'months' },
          serverUserId: null,
          serverId: null,
          isActive: true,
        };

        const result = convertLegacyRule(legacyRule);

        expect(result?.conditions.groups[0]?.conditions[0]).toEqual({
          field: 'inactive_days',
          operator: 'gt',
          value: 90,
        });
      });
    });

    it('returns null for unknown rule type', () => {
      const legacyRule = {
        id: 'rule-1',
        name: 'Unknown Rule',
        type: 'unknown_type' as never,
        params: {},
        serverUserId: null,
        serverId: null,
        isActive: true,
      };

      const result = convertLegacyRule(legacyRule);

      expect(result).toBeNull();
    });
  });

  describe('migrateRules', () => {
    it('migrates multiple rules', () => {
      const rules: LegacyRule[] = [
        {
          id: 'rule-1',
          name: 'Rule 1',
          type: 'concurrent_streams',
          params: { maxStreams: 3 },
          serverUserId: null,
          serverId: null,
          isActive: true,
        },
        {
          id: 'rule-2',
          name: 'Rule 2',
          type: 'geo_restriction',
          params: { mode: 'blocklist', countries: ['CN'] },
          serverUserId: null,
          serverId: null,
          isActive: true,
        },
      ];

      const result = migrateRules(rules);

      expect(result.migrated).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
      expect(result.migrated[0]?.id).toBe('rule-1');
      expect(result.migrated[1]?.id).toBe('rule-2');
    });

    it('collects errors for failed migrations', () => {
      const rules: LegacyRule[] = [
        {
          id: 'rule-1',
          name: 'Rule 1',
          type: 'concurrent_streams',
          params: { maxStreams: 3 },
          serverUserId: null,
          serverId: null,
          isActive: true,
        },
        {
          id: 'rule-2',
          name: 'Unknown Rule',
          type: 'unknown_type' as never,
          params: {},
          serverUserId: null,
          serverId: null,
          isActive: true,
        },
      ];

      const result = migrateRules(rules);

      expect(result.migrated).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.ruleId).toBe('rule-2');
    });

    it('returns empty arrays for empty input', () => {
      const result = migrateRules([]);

      expect(result.migrated).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });
  });
});
