/**
 * Rule evaluation engine
 */

import type {
  Rule,
  Session,
  ViolationSeverity,
  ImpossibleTravelParams,
  SimultaneousLocationsParams,
  DeviceVelocityParams,
  ConcurrentStreamsParams,
  GeoRestrictionParams,
} from '@tracearr/shared';
import { GEOIP_CONFIG, TIME_MS } from '@tracearr/shared';
import { geoipService } from './geoip.js';
import countries from 'i18n-iso-countries';
import countriesEn from 'i18n-iso-countries/langs/en.json' with { type: 'json' };
import { EXCLUDED_MEDIA_TYPES_SET } from '../constants/index.js';

// Register English locale for country name lookups
countries.registerLocale(countriesEn);

/** Constant for local network country value - must match geoip service */
const LOCAL_NETWORK_COUNTRY = 'Local Network';

/**
 * Normalize a country value to ISO 3166-1 alpha-2 code.
 * Handles both country names ("Italy") and codes ("IT").
 * Returns null if the country cannot be normalized.
 */
function normalizeToCountryCode(country: string): string | null {
  if (!country || country === LOCAL_NETWORK_COUNTRY) {
    return null;
  }

  // If it's already a 2-letter code, validate and return uppercase
  if (country.length === 2) {
    const upper = country.toUpperCase();
    // Verify it's a valid country code
    if (countries.getName(upper, 'en')) {
      return upper;
    }
  }

  // Try to convert country name to code
  const code = countries.getAlpha2Code(country, 'en');
  if (code) {
    return code;
  }

  // Fallback: return the original value uppercase (might be a valid code)
  return country.length === 2 ? country.toUpperCase() : null;
}

export interface RuleEvaluationResult {
  violated: boolean;
  severity: ViolationSeverity;
  data: Record<string, unknown>;
  /** Issue #67: Include the rule that produced this result for correct violation attribution */
  rule?: Rule;
}

export class RuleEngine {
  /**
   * Check if a session is from a local/private network
   * Checks both geoCountry AND IP address for robustness
   */
  private isLocalNetworkSession(session: Session): boolean {
    return (
      session.geoCountry === LOCAL_NETWORK_COUNTRY || geoipService.isPrivateIP(session.ipAddress)
    );
  }

  /**
   * Check if a session should be excluded based on private IP filtering
   * @param session The session to check
   * @param excludePrivateIps Whether to exclude private IPs
   * @returns true if the session should be excluded (is from local network and filtering is enabled)
   */
  private shouldExcludeSession(session: Session, excludePrivateIps?: boolean): boolean {
    return excludePrivateIps === true && this.isLocalNetworkSession(session);
  }

  /**
   * Filter sessions based on private IP exclusion setting
   * @param sessions Sessions to filter
   * @param excludePrivateIps Whether to exclude private IPs
   * @returns Filtered sessions (excluding local network sessions if enabled)
   */
  private filterByPrivateIp(sessions: Session[], excludePrivateIps?: boolean): Session[] {
    if (!excludePrivateIps) {
      return sessions;
    }
    return sessions.filter((s) => !this.isLocalNetworkSession(s));
  }

  /**
   * Filter IP addresses based on private IP exclusion setting
   * Uses geoipService.isPrivateIP for raw IP strings (device_velocity)
   * @param ips IP addresses to filter
   * @param excludePrivateIps Whether to exclude private IPs
   * @returns Filtered IPs (excluding private IPs if enabled)
   */
  private filterPrivateIps(ips: string[], excludePrivateIps?: boolean): string[] {
    if (!excludePrivateIps) {
      return ips;
    }
    return ips.filter((ip) => !geoipService.isPrivateIP(ip));
  }

  /**
   * Evaluate all active rules against a new session
   */
  async evaluateSession(
    session: Session,
    activeRules: Rule[],
    recentSessions: Session[]
  ): Promise<RuleEvaluationResult[]> {
    // Skip live TV/music - these don't indicate sharing/abuse patterns
    if (EXCLUDED_MEDIA_TYPES_SET.has(session.mediaType)) {
      return [];
    }

    // Exclude live TV/music from recent sessions (don't count toward violations)
    const filteredRecentSessions = recentSessions.filter(
      (s) => !EXCLUDED_MEDIA_TYPES_SET.has(s.mediaType)
    );

    const results: RuleEvaluationResult[] = [];

    for (const rule of activeRules) {
      // Skip rules that don't apply to this server user
      if (rule.serverUserId !== null && rule.serverUserId !== session.serverUserId) {
        continue;
      }

      const result = await this.evaluateRule(rule, session, filteredRecentSessions);
      if (result.violated) {
        // Issue #67: Include the rule that produced this result for correct violation attribution
        results.push({ ...result, rule });
      }
    }

    return results;
  }

  private async evaluateRule(
    rule: Rule,
    session: Session,
    recentSessions: Session[]
  ): Promise<RuleEvaluationResult> {
    switch (rule.type) {
      case 'impossible_travel':
        return this.checkImpossibleTravel(
          session,
          recentSessions,
          rule.params as ImpossibleTravelParams
        );
      case 'simultaneous_locations':
        return this.checkSimultaneousLocations(
          session,
          recentSessions,
          rule.params as SimultaneousLocationsParams
        );
      case 'device_velocity':
        return this.checkDeviceVelocity(
          session,
          recentSessions,
          rule.params as DeviceVelocityParams
        );
      case 'concurrent_streams':
        return this.checkConcurrentStreams(
          session,
          recentSessions,
          rule.params as ConcurrentStreamsParams
        );
      case 'geo_restriction':
        return this.checkGeoRestriction(session, rule.params as GeoRestrictionParams);
      default:
        return { violated: false, severity: 'low', data: {} };
    }
  }

  private checkImpossibleTravel(
    session: Session,
    recentSessions: Session[],
    params: ImpossibleTravelParams
  ): RuleEvaluationResult {
    // Issue #82: Skip if current session is from private IP and excludePrivateIps is enabled
    if (this.shouldExcludeSession(session, params.excludePrivateIps)) {
      return { violated: false, severity: 'low', data: {} };
    }

    // Find most recent session from same server user with different location
    const userSessions = this.filterByPrivateIp(recentSessions, params.excludePrivateIps).filter(
      (s) =>
        s.serverUserId === session.serverUserId &&
        s.geoLat !== null &&
        s.geoLon !== null &&
        session.geoLat !== null &&
        session.geoLon !== null &&
        // Issue #67: Exclude same device - VPN switches on same device are not impossible travel
        !(session.deviceId && s.deviceId && session.deviceId === s.deviceId)
    );

    for (const prevSession of userSessions) {
      const distance = this.calculateDistance(
        prevSession.geoLat!,
        prevSession.geoLon!,
        session.geoLat!,
        session.geoLon!
      );

      const timeDiffHours =
        (session.startedAt.getTime() - prevSession.startedAt.getTime()) / (1000 * 60 * 60);

      if (timeDiffHours > 0) {
        const speed = distance / timeDiffHours;
        if (speed > params.maxSpeedKmh) {
          return {
            violated: true,
            severity: 'high',
            data: {
              previousLocation: { lat: prevSession.geoLat, lon: prevSession.geoLon },
              currentLocation: { lat: session.geoLat, lon: session.geoLon },
              distance,
              timeDiffHours,
              calculatedSpeed: speed,
              maxAllowedSpeed: params.maxSpeedKmh,
            },
          };
        }
      }
    }

    return { violated: false, severity: 'low', data: {} };
  }

  private checkSimultaneousLocations(
    session: Session,
    recentSessions: Session[],
    params: SimultaneousLocationsParams
  ): RuleEvaluationResult {
    // Issue #82: Skip if current session is from private IP and excludePrivateIps is enabled
    if (this.shouldExcludeSession(session, params.excludePrivateIps)) {
      return { violated: false, severity: 'low', data: {} };
    }

    // Check for active sessions from same server user at different locations
    const activeSessions = this.filterByPrivateIp(recentSessions, params.excludePrivateIps).filter(
      (s) =>
        s.serverUserId === session.serverUserId &&
        s.state === 'playing' &&
        // Issue #67: Exclude stopped sessions (stoppedAt takes precedence over state)
        s.stoppedAt === null &&
        s.geoLat !== null &&
        s.geoLon !== null &&
        session.geoLat !== null &&
        session.geoLon !== null &&
        // Exclude sessions from the same device (likely stale session data)
        !(session.deviceId && s.deviceId && session.deviceId === s.deviceId)
    );

    // Find all sessions at different locations (distance > minDistanceKm)
    const conflictingSessions = activeSessions.filter((activeSession) => {
      const distance = this.calculateDistance(
        activeSession.geoLat!,
        activeSession.geoLon!,
        session.geoLat!,
        session.geoLon!
      );
      return distance > params.minDistanceKm;
    });

    if (conflictingSessions.length > 0) {
      // Calculate max distance for reporting
      const maxDistance = Math.max(
        ...conflictingSessions.map((s) =>
          this.calculateDistance(s.geoLat!, s.geoLon!, session.geoLat!, session.geoLon!)
        )
      );

      // Collect all unique locations (including triggering session)
      const allLocations = [
        { lat: session.geoLat, lon: session.geoLon, sessionId: session.id },
        ...conflictingSessions.map((s) => ({
          lat: s.geoLat,
          lon: s.geoLon,
          sessionId: s.id,
        })),
      ];

      // Collect all session IDs for deduplication and related sessions lookup
      const relatedSessionIds = conflictingSessions.map((s) => s.id);

      return {
        violated: true,
        severity: 'warning',
        data: {
          locations: allLocations,
          locationCount: allLocations.length,
          distance: maxDistance,
          minRequiredDistance: params.minDistanceKm,
          relatedSessionIds,
        },
      };
    }

    return { violated: false, severity: 'low', data: {} };
  }

  private checkDeviceVelocity(
    session: Session,
    recentSessions: Session[],
    params: DeviceVelocityParams
  ): RuleEvaluationResult {
    const windowStart = new Date(session.startedAt.getTime() - params.windowHours * TIME_MS.HOUR);

    const userSessions = recentSessions.filter(
      (s) => s.serverUserId === session.serverUserId && s.startedAt >= windowStart
    );

    const allSessions = [...userSessions];
    if (!this.shouldExcludeSession(session, params.excludePrivateIps)) {
      allSessions.push(session);
    }

    let uniqueSources: Set<string>;
    const uniqueIps = new Set<string>();

    if (params.groupByDevice) {
      // Group by deviceId - each device counts as 1 source regardless of IP changes
      uniqueSources = new Set<string>();

      for (const s of allSessions) {
        if (params.excludePrivateIps && geoipService.isPrivateIP(s.ipAddress)) {
          continue;
        }

        const sourceKey = s.deviceId ?? `ip:${s.ipAddress}`;
        uniqueSources.add(sourceKey);
        uniqueIps.add(s.ipAddress);
      }
    } else {
      const allIps = allSessions.map((s) => s.ipAddress);
      const filteredIps = this.filterPrivateIps(allIps, params.excludePrivateIps);

      for (const ip of filteredIps) {
        uniqueIps.add(ip);
      }
      uniqueSources = uniqueIps;
    }

    if (uniqueSources.size > params.maxIps) {
      return {
        violated: true,
        severity: 'warning',
        data: {
          uniqueIpCount: uniqueSources.size,
          maxAllowedIps: params.maxIps,
          windowHours: params.windowHours,
          ips: Array.from(uniqueIps),
          ...(params.groupByDevice && { groupedByDevice: true }),
        },
      };
    }

    return { violated: false, severity: 'low', data: {} };
  }

  private checkConcurrentStreams(
    session: Session,
    recentSessions: Session[],
    params: ConcurrentStreamsParams
  ): RuleEvaluationResult {
    // Issue #82: Filter out private IP sessions if excludePrivateIps is enabled
    const filteredSessions = this.filterByPrivateIp(recentSessions, params.excludePrivateIps);

    const activeSessions = filteredSessions.filter(
      (s) =>
        s.serverUserId === session.serverUserId &&
        s.state === 'playing' &&
        // Issue #67: Exclude stopped sessions (stoppedAt takes precedence over state)
        // This handles stale snapshot bug where state='playing' but session was stopped
        s.stoppedAt === null &&
        // Exclude sessions from the same device (likely reconnects/stale sessions)
        // A single device can only play one stream at a time
        !(session.deviceId && s.deviceId && session.deviceId === s.deviceId)
    );

    // Add 1 for current session only if it's not excluded
    const currentSessionExcluded = this.shouldExcludeSession(session, params.excludePrivateIps);
    const totalStreams = activeSessions.length + (currentSessionExcluded ? 0 : 1);

    if (totalStreams > params.maxStreams) {
      // Collect all session IDs for deduplication and related sessions lookup
      const relatedSessionIds = activeSessions.map((s) => s.id);

      return {
        violated: true,
        severity: 'low',
        data: {
          activeStreamCount: totalStreams,
          maxAllowedStreams: params.maxStreams,
          relatedSessionIds,
        },
      };
    }

    return { violated: false, severity: 'low', data: {} };
  }

  private checkGeoRestriction(
    session: Session,
    params: GeoRestrictionParams
  ): RuleEvaluationResult {
    // Handle backwards compatibility: old rules have blockedCountries, new rules have mode + countries
    const mode = params.mode ?? 'blocklist';
    const ruleCountries =
      params.countries ??
      (params as unknown as { blockedCountries?: string[] }).blockedCountries ??
      [];

    // Skip local/private IPs - they have no meaningful geo location
    if (
      !session.geoCountry ||
      session.geoCountry === LOCAL_NETWORK_COUNTRY ||
      ruleCountries.length === 0
    ) {
      return { violated: false, severity: 'low', data: {} };
    }

    // Normalize session's country to ISO code for consistent comparison
    // Session might have full name ("Italy") or code ("IT")
    // Rule list should have codes, but normalize both for safety
    const sessionCountryCode = normalizeToCountryCode(session.geoCountry);

    // If we can't normalize the session's country, skip the check
    // (better to allow than to incorrectly block)
    if (!sessionCountryCode) {
      return { violated: false, severity: 'low', data: {} };
    }

    // Normalize the rule's country list (should be codes, but handle names too)
    const normalizedRuleCountries = ruleCountries
      .map((c) => normalizeToCountryCode(c))
      .filter((c): c is string => c !== null);

    const isInList = normalizedRuleCountries.includes(sessionCountryCode);
    const violated = mode === 'blocklist' ? isInList : !isInList;

    if (violated) {
      return {
        violated: true,
        severity: 'high',
        data: {
          country: session.geoCountry,
          countryCode: sessionCountryCode,
          mode,
          countries: ruleCountries,
        },
      };
    }

    return { violated: false, severity: 'low', data: {} };
  }

  /**
   * Calculate distance between two points using Haversine formula
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = GEOIP_CONFIG.EARTH_RADIUS_KM;
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) *
        Math.cos(this.toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }
}

export const ruleEngine = new RuleEngine();
