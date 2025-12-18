/**
 * Rule factory for test data generation
 *
 * Creates sharing detection rules with proper typed params.
 */

import { executeRawSql } from '../db/pool.js';

export type RuleType =
  | 'impossible_travel'
  | 'simultaneous_locations'
  | 'device_velocity'
  | 'concurrent_streams'
  | 'geo_restriction';

export interface ImpossibleTravelParams {
  max_speed_kmh: number;
}

export interface SimultaneousLocationsParams {
  min_distance_km: number;
}

export interface DeviceVelocityParams {
  max_ips: number;
  window_hours: number;
}

export interface ConcurrentStreamsParams {
  max_streams: number;
}

export interface GeoRestrictionParams {
  blocked_countries: string[];
}

export type RuleParams =
  | ImpossibleTravelParams
  | SimultaneousLocationsParams
  | DeviceVelocityParams
  | ConcurrentStreamsParams
  | GeoRestrictionParams;

export interface RuleData {
  id?: string;
  name?: string;
  type: RuleType;
  params: RuleParams;
  serverUserId?: string | null;
  isActive?: boolean;
}

export interface CreatedRule {
  id: string;
  name: string;
  type: RuleType;
  params: RuleParams;
  serverUserId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

let ruleCounter = 0;

/**
 * Default params for each rule type
 */
const DEFAULT_PARAMS: Record<RuleType, RuleParams> = {
  impossible_travel: { max_speed_kmh: 500 },
  simultaneous_locations: { min_distance_km: 100 },
  device_velocity: { max_ips: 5, window_hours: 24 },
  concurrent_streams: { max_streams: 3 },
  geo_restriction: { blocked_countries: [] },
};

/**
 * Generate unique rule data with defaults
 */
export function buildRule(overrides: RuleData): Required<RuleData> {
  const index = ++ruleCounter;
  const type = overrides.type;

  return {
    id: overrides.id ?? crypto.randomUUID(),
    name:
      overrides.name ??
      `${type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} Rule ${index}`,
    type,
    params: overrides.params ?? DEFAULT_PARAMS[type],
    serverUserId: overrides.serverUserId ?? null,
    isActive: overrides.isActive ?? true,
  };
}

/**
 * Create a rule in the database
 */
export async function createTestRule(data: RuleData): Promise<CreatedRule> {
  const fullData = buildRule(data);

  const result = await executeRawSql(`
    INSERT INTO rules (id, name, type, params, server_user_id, is_active)
    VALUES (
      '${fullData.id}',
      '${fullData.name}',
      '${fullData.type}',
      '${JSON.stringify(fullData.params)}'::jsonb,
      ${fullData.serverUserId ? `'${fullData.serverUserId}'` : 'NULL'},
      ${fullData.isActive}
    )
    RETURNING *
  `);

  return mapRuleRow(result.rows[0]);
}

/**
 * Create an impossible travel rule
 */
export async function createImpossibleTravelRule(
  params: Partial<ImpossibleTravelParams> = {},
  overrides: Partial<Omit<RuleData, 'type' | 'params'>> = {}
): Promise<CreatedRule> {
  return createTestRule({
    type: 'impossible_travel',
    params: { ...DEFAULT_PARAMS.impossible_travel, ...params } as ImpossibleTravelParams,
    ...overrides,
  });
}

/**
 * Create a simultaneous locations rule
 */
export async function createSimultaneousLocationsRule(
  params: Partial<SimultaneousLocationsParams> = {},
  overrides: Partial<Omit<RuleData, 'type' | 'params'>> = {}
): Promise<CreatedRule> {
  return createTestRule({
    type: 'simultaneous_locations',
    params: { ...DEFAULT_PARAMS.simultaneous_locations, ...params } as SimultaneousLocationsParams,
    ...overrides,
  });
}

/**
 * Create a device velocity rule
 */
export async function createDeviceVelocityRule(
  params: Partial<DeviceVelocityParams> = {},
  overrides: Partial<Omit<RuleData, 'type' | 'params'>> = {}
): Promise<CreatedRule> {
  return createTestRule({
    type: 'device_velocity',
    params: { ...DEFAULT_PARAMS.device_velocity, ...params } as DeviceVelocityParams,
    ...overrides,
  });
}

/**
 * Create a concurrent streams rule
 */
export async function createConcurrentStreamsRule(
  params: Partial<ConcurrentStreamsParams> = {},
  overrides: Partial<Omit<RuleData, 'type' | 'params'>> = {}
): Promise<CreatedRule> {
  return createTestRule({
    type: 'concurrent_streams',
    params: { ...DEFAULT_PARAMS.concurrent_streams, ...params } as ConcurrentStreamsParams,
    ...overrides,
  });
}

/**
 * Create a geo restriction rule
 */
export async function createGeoRestrictionRule(
  params: Partial<GeoRestrictionParams> = {},
  overrides: Partial<Omit<RuleData, 'type' | 'params'>> = {}
): Promise<CreatedRule> {
  return createTestRule({
    type: 'geo_restriction',
    params: { ...DEFAULT_PARAMS.geo_restriction, ...params } as GeoRestrictionParams,
    ...overrides,
  });
}

/**
 * Map database row to typed rule object
 */
function mapRuleRow(row: Record<string, unknown>): CreatedRule {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as RuleType,
    params: row.params as RuleParams,
    serverUserId: row.server_user_id as string | null,
    isActive: row.is_active as boolean,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Reset rule counter
 */
export function resetRuleCounter(): void {
  ruleCounter = 0;
}
