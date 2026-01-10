/**
 * Plex GeoIP lookup service
 *
 * Uses Plex's GeoIP API (https://plex.tv/api/v2/geoip) with fallback to MaxMind.
 * When enabled, tries Plex first for potentially more accurate/complete data,
 * falls back to MaxMind on errors or incomplete results.
 */

import { geoipService, type GeoLocation } from './geoip.js';

const PLEX_GEOIP_URL = 'https://plex.tv/api/v2/geoip';
const PLEX_GEOIP_TIMEOUT = 5000; // 5 second timeout

/**
 * Extract an attribute value from XML
 */
function extractXmlAttribute(xml: string, attr: string): string {
  const match = xml.match(new RegExp(`${attr}="([^"]+)"`));
  return match?.[1] ?? '';
}

/**
 * Parse coordinates from Plex format "lat, lon"
 */
function parseCoordinates(coordStr: string): { lat: number; lon: number } | null {
  if (!coordStr) return null;
  const parts = coordStr.split(',').map((s) => parseFloat(s.trim()));
  if (parts.length !== 2 || parts.some(isNaN)) return null;
  return { lat: parts[0]!, lon: parts[1]! };
}

/**
 * Lookup GeoIP using Plex's API
 * Returns null on any error (network, timeout, parse, rate limit)
 */
async function lookupPlex(ip: string): Promise<GeoLocation | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PLEX_GEOIP_TIMEOUT);

    const response = await fetch(`${PLEX_GEOIP_URL}?ip_address=${encodeURIComponent(ip)}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/xml',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      // Rate limited (429) or other error
      return null;
    }

    const xml = await response.text();

    // Parse the XML response
    // Example: <location code="US" country="United States" city="New York" subdivisions="New York" coordinates="40.7, -74.0" .../>
    const countryCode = extractXmlAttribute(xml, 'code') || null;
    const country = extractXmlAttribute(xml, 'country') || null;
    const city = extractXmlAttribute(xml, 'city') || null;
    const region = extractXmlAttribute(xml, 'subdivisions') || null;
    const coordStr = extractXmlAttribute(xml, 'coordinates');
    const coords = parseCoordinates(coordStr);

    return {
      city,
      region,
      country,
      countryCode,
      lat: coords?.lat ?? null,
      lon: coords?.lon ?? null,
    };
  } catch {
    // Network error, timeout, or parse error
    return null;
  }
}

/**
 * Count non-null fields in a GeoLocation
 */
function countFields(loc: GeoLocation): number {
  return [loc.city, loc.region, loc.country, loc.countryCode, loc.lat, loc.lon].filter(
    (v) => v !== null
  ).length;
}

/**
 * Hybrid GeoIP lookup
 *
 * When usePlexGeoip is enabled:
 * 1. Try Plex API first
 * 2. If error OR missing city → also try MaxMind
 * 3. Return whichever has more non-null fields (prefer Plex on tie)
 *
 * When disabled, uses MaxMind only.
 */
export async function lookupGeoIP(ip: string, usePlexGeoip: boolean): Promise<GeoLocation> {
  // Always delegate private IP check to geoipService (returns LOCAL_LOCATION)
  if (geoipService.isPrivateIP(ip)) {
    return geoipService.lookup(ip);
  }

  // If Plex GeoIP is disabled, use MaxMind only
  if (!usePlexGeoip) {
    return geoipService.lookup(ip);
  }

  // Try Plex first
  const plexResult = await lookupPlex(ip);

  // If Plex failed completely, use MaxMind
  if (!plexResult) {
    return geoipService.lookup(ip);
  }

  // If Plex returned data but missing city, also try MaxMind and compare
  if (!plexResult.city) {
    const maxmindResult = geoipService.lookup(ip);

    // Return whichever has more data (prefer Plex on tie)
    const plexFields = countFields(plexResult);
    const maxmindFields = countFields(maxmindResult);

    return maxmindFields > plexFields ? maxmindResult : plexResult;
  }

  // Plex succeeded with city data - use it
  return plexResult;
}
