import type { GeoLocation } from './geoip.js';

export interface ServerLocation {
  effectiveFrom: Date | null;
  lat: number;
  lon: number;
  city: string | null;
  region: string | null;
  country: string;
}

export interface LocationRange {
  /** Inclusive; null is the start of time */
  from: Date | null;
  /** Exclusive; null is the end of time */
  to: Date | null;
  /** Null means the unplaced shape */
  location: ServerLocation | null;
}

export function locationRanges(entries: ServerLocation[]): LocationRange[] {
  const sorted = entries.toSorted(
    (a, b) => (a.effectiveFrom?.getTime() ?? -Infinity) - (b.effectiveFrom?.getTime() ?? -Infinity)
  );
  const first = sorted[0];
  if (!first) return [{ from: null, to: null, location: null }];
  const ranges: LocationRange[] =
    first.effectiveFrom === null ? [] : [{ from: null, to: first.effectiveFrom, location: null }];
  sorted.forEach((entry, index) => {
    ranges.push({
      from: entry.effectiveFrom,
      to: sorted[index + 1]?.effectiveFrom ?? null,
      location: entry,
    });
  });
  return ranges;
}

export function locationAt(entries: ServerLocation[], at: Date): ServerLocation | null {
  const time = at.getTime();
  const range = locationRanges(entries).find(
    (r) => (r.from === null || r.from.getTime() <= time) && (r.to === null || time < r.to.getTime())
  );
  return range?.location ?? null;
}

export function placeLocal(geo: GeoLocation, location: ServerLocation | null): GeoLocation {
  if (!location) return geo;
  return {
    ...geo,
    city: location.city,
    region: location.region,
    country: location.country,
    countryCode: location.country,
    continent: null,
    postal: null,
    lat: location.lat,
    lon: location.lon,
  };
}
