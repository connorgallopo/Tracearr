import { describe, it, expect } from 'vitest';
import { renderSql } from '../../test/helpers.js';
import {
  isLocalSession,
  localSessionSql,
  type LocalSessionFields,
} from '../../db/sessions/rules.js';

function row(overrides: Partial<LocalSessionFields>): LocalSessionFields {
  return { isLocal: null, geoCountry: null, geoCity: null, geoLat: null, ...overrides };
}

describe('isLocalSession', () => {
  it('trusts the flag once it is set', () => {
    expect(
      isLocalSession(row({ isLocal: true, geoCountry: 'US', geoCity: 'Chicago', geoLat: 41.9 }))
    ).toBe(true);
    expect(isLocalSession(row({ isLocal: false, geoCountry: 'Local Network' }))).toBe(false);
  });

  it('falls back to the Local Network label before the sync has classified a row', () => {
    expect(isLocalSession(row({ geoCountry: 'Local Network' }))).toBe(true);
    expect(isLocalSession(row({ isLocal: undefined, geoCountry: 'Local Network' }))).toBe(true);
  });

  it('recognizes rows written before 2025-12-22 with a Local city and no country', () => {
    expect(isLocalSession(row({ geoCity: 'Local' }))).toBe(true);
  });

  it('does not treat a real city named Local as local', () => {
    expect(isLocalSession(row({ geoCity: 'Local', geoCountry: 'DE', geoLat: 50.1 }))).toBe(false);
  });

  it('treats an unclassified remote row as remote', () => {
    expect(isLocalSession(row({ geoCountry: 'US', geoCity: 'Chicago', geoLat: 41.9 }))).toBe(false);
  });
});

describe('localSessionSql', () => {
  it('renders without bound parameters so a GROUP BY can repeat it', () => {
    const rendered = renderSql(localSessionSql('s'));
    expect(rendered.params).toEqual([]);
    expect(rendered.sql).toContain("s.geo_country IS NOT DISTINCT FROM 'Local Network'");
    expect(rendered.sql).toContain('s.is_local IS TRUE');
  });
});
