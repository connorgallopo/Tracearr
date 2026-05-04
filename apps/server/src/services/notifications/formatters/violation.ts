/**
 * Shared violation formatting utilities
 */

import {
  SEVERITY_LEVELS,
  CONDITION_FIELD_LABELS,
  OPERATOR_LABELS,
  type GroupEvidence,
} from '@tracearr/shared';
import type { ViolationWithDetails } from '../types.js';
import type { DiscordEmbedField } from '../agents/discord.js';

/** Fallback values when rule config doesn't specify */
export const VIOLATION_DEFAULTS = {
  MAX_SPEED_KMH: 500,
  MAX_STREAMS: 1,
  MAX_IPS: 5,
  WINDOW_HOURS: 24,
} as const;

/**
 * Truncate a string to fit Discord's field value limit (1024 chars)
 */
export function truncateForDiscord(text: string, maxLength = 1000): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Validate lat/lon are finite numbers within valid ranges
 */
export function areValidCoordinates(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * Escape markdown and remove invisible unicode chars
 */
export function sanitizeForDiscord(text: string): string {
  return text
    .replace(/[*_`~[\]()\\]/g, '\\$&')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u202A-\u202E]/g, '');
}

/**
 * Get the rule display name for a violation
 */
/** @deprecated V1 rules no longer exist. Use violation.rule.name directly. */
export function getRuleDisplayName(ruleType: string | null): string {
  if (!ruleType) return 'Custom Rule';
  return ruleType;
}

/**
 * Get the severity display info for a violation
 */
export function getSeverityInfo(severity: string): { label: string; color: number } {
  const severityInfo = SEVERITY_LEVELS[severity as keyof typeof SEVERITY_LEVELS];
  const colors: Record<string, number> = {
    low: 0x3498db,
    warning: 0xf39c12,
    high: 0xe74c3c,
  };
  return {
    label: severityInfo?.label ?? severity,
    color: colors[severity] ?? 0x3498db,
  };
}

/**
 * Format violation details into Discord embed fields based on rule type
 */
/**
 * Format evidence from V2 rule evaluation into Discord embed fields.
 */
function formatEvidenceForDiscord(evidence: GroupEvidence[]): DiscordEmbedField[] {
  const fields: DiscordEmbedField[] = [];

  for (const group of evidence) {
    const matchedConditions = group.conditions.filter((c) => c.matched);
    for (const cond of matchedConditions) {
      const label = CONDITION_FIELD_LABELS[cond.field] ?? cond.field;
      const op = OPERATOR_LABELS[cond.operator] ?? cond.operator;
      const actual =
        cond.actual !== null && cond.actual !== undefined ? String(cond.actual) : 'N/A';
      const threshold = String(cond.threshold);

      fields.push({
        name: label,
        value: truncateForDiscord(`**${actual}** (${op} ${threshold})`),
        inline: true,
      });
    }
  }

  return fields;
}

/**
 * Format violation details into Discord embed fields based on rule type
 */
export function formatViolationDetailsForDiscord(
  ruleType: string | null,
  data: Record<string, unknown> | null
): DiscordEmbedField[] {
  if (!data) return [];

  // V2 violations: format from evidence
  if (!ruleType && Array.isArray(data.evidence)) {
    return formatEvidenceForDiscord(data.evidence as GroupEvidence[]);
  }

  if (!ruleType) return [];

  switch (ruleType) {
    case 'impossible_travel': {
      const d = data as {
        distance?: number;
        timeDiffHours?: number;
        calculatedSpeed?: number;
        maxAllowedSpeed?: number;
        currentLocation?: { lat: number; lon: number };
        previousLocation?: { lat: number; lon: number };
      };
      const fields: DiscordEmbedField[] = [];

      if (d.distance != null) {
        fields.push({
          name: 'Distance',
          value: truncateForDiscord(`**${d.distance.toFixed(1)} km**`),
          inline: true,
        });
      }
      if (d.timeDiffHours != null) {
        const minutes = Math.round(d.timeDiffHours * 60);
        fields.push({
          name: 'Time Gap',
          value: truncateForDiscord(`**${minutes} min**`),
          inline: true,
        });
      }
      if (d.calculatedSpeed != null) {
        fields.push({
          name: 'Speed',
          value: truncateForDiscord(
            `**${Math.round(d.calculatedSpeed)} km/h** (max: ${d.maxAllowedSpeed ?? VIOLATION_DEFAULTS.MAX_SPEED_KMH})`
          ),
          inline: true,
        });
      }
      if (
        d.previousLocation &&
        d.currentLocation &&
        areValidCoordinates(d.previousLocation.lat, d.previousLocation.lon) &&
        areValidCoordinates(d.currentLocation.lat, d.currentLocation.lon)
      ) {
        fields.push({
          name: 'Route',
          value: truncateForDiscord(
            `[View on Map](https://www.google.com/maps/dir/${d.previousLocation.lat},${d.previousLocation.lon}/${d.currentLocation.lat},${d.currentLocation.lon})`
          ),
          inline: false,
        });
      }
      return fields;
    }

    case 'simultaneous_locations': {
      const d = data as {
        locationCount?: number;
        distance?: number;
        minRequiredDistance?: number;
        locations?: Array<{ lat: number; lon: number; city?: string; country?: string }>;
      };
      const fields: DiscordEmbedField[] = [];

      if (d.locationCount != null) {
        fields.push({
          name: 'Locations',
          value: truncateForDiscord(`**${d.locationCount}** active`),
          inline: true,
        });
      }
      if (d.distance != null) {
        fields.push({
          name: 'Distance',
          value: truncateForDiscord(`**${d.distance.toFixed(1)} km** apart`),
          inline: true,
        });
      }
      if (d.locations && d.locations.length > 0) {
        const locationList = d.locations
          .slice(0, 3)
          .filter((loc) => (loc.city && loc.country) || areValidCoordinates(loc.lat, loc.lon))
          .map((loc) => {
            if (loc.city && loc.country) {
              return `${sanitizeForDiscord(loc.city)}, ${sanitizeForDiscord(loc.country)}`;
            }
            return `${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`;
          })
          .join('\n');
        if (locationList) {
          fields.push({
            name: 'Active Locations',
            value: truncateForDiscord(locationList),
            inline: false,
          });
        }
      }
      return fields;
    }

    case 'max_streams': {
      const d = data as {
        streamCount?: number;
        maxAllowed?: number;
        streams?: Array<{ title?: string; player?: string }>;
      };
      const fields: DiscordEmbedField[] = [];

      fields.push({
        name: 'Streams',
        value: truncateForDiscord(
          `**${d.streamCount ?? 'N/A'}** (max: ${d.maxAllowed ?? VIOLATION_DEFAULTS.MAX_STREAMS})`
        ),
        inline: true,
      });
      if (d.streams && d.streams.length > 0) {
        const streamList = d.streams
          .slice(0, 3)
          .map((s) => {
            const title = s.title ? sanitizeForDiscord(s.title) : 'Unknown';
            const player = s.player ? ` on ${sanitizeForDiscord(s.player)}` : '';
            return `• ${title}${player}`;
          })
          .join('\n');
        if (streamList) {
          fields.push({
            name: 'Active Streams',
            value: truncateForDiscord(streamList),
            inline: false,
          });
        }
      }
      return fields;
    }

    case 'max_ips': {
      const d = data as {
        ipCount?: number;
        maxAllowed?: number;
        windowHours?: number;
        ips?: string[];
      };
      const fields: DiscordEmbedField[] = [];

      fields.push({
        name: 'IPs Used',
        value: truncateForDiscord(
          `**${d.ipCount ?? 'N/A'}** in ${d.windowHours ?? VIOLATION_DEFAULTS.WINDOW_HOURS}h (max: ${d.maxAllowed ?? VIOLATION_DEFAULTS.MAX_IPS})`
        ),
        inline: true,
      });
      if (d.ips && d.ips.length > 0) {
        fields.push({
          name: 'IP Addresses',
          value: truncateForDiscord(d.ips.slice(0, 5).join('\n')),
          inline: false,
        });
      }
      return fields;
    }

    case 'geo_restriction': {
      const d = data as {
        country?: string;
        countryCode?: string;
        allowedCountries?: string[];
        blockedCountries?: string[];
      };
      const fields: DiscordEmbedField[] = [];

      if (d.country || d.countryCode) {
        fields.push({
          name: 'Location',
          value: truncateForDiscord(
            `**${sanitizeForDiscord(d.country ?? d.countryCode ?? 'Unknown')}**`
          ),
          inline: true,
        });
      }
      if (d.allowedCountries && d.allowedCountries.length > 0) {
        fields.push({
          name: 'Allowed Countries',
          value: truncateForDiscord(d.allowedCountries.slice(0, 5).join(', ')),
          inline: true,
        });
      }
      if (d.blockedCountries && d.blockedCountries.length > 0) {
        fields.push({
          name: 'Blocked Countries',
          value: truncateForDiscord(d.blockedCountries.slice(0, 5).join(', ')),
          inline: true,
        });
      }
      return fields;
    }

    default:
      return [];
  }
}

/**
 * Format violation for plain text (ntfy, apprise, pushover)
 */
export function formatViolationMessage(violation: ViolationWithDetails): string {
  const userName = violation.user.identityName ?? violation.user.username;
  const ruleName = violation.rule.name;
  const severity = violation.severity as keyof typeof SEVERITY_LEVELS;

  return `User ${userName} triggered ${ruleName} (${SEVERITY_LEVELS[severity].label} severity)`;
}
