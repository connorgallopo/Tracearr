import { describe, it, expect } from 'vitest';
import { normalizePlexGuid } from '../plexGuid.js';

describe('normalizePlexGuid', () => {
  it('normalizes a movie guid and strips the query string', () => {
    expect(normalizePlexGuid('plex://movie/5d776b59ad5437001f79c6f8?lang=en')).toEqual({
      guid: 'plex://movie/5d776b59ad5437001f79c6f8',
      mediaType: 'movie',
    });
  });

  it('normalizes an episode guid', () => {
    expect(normalizePlexGuid('plex://episode/5d9c0874ffd9ef001eba9f01')).toEqual({
      guid: 'plex://episode/5d9c0874ffd9ef001eba9f01',
      mediaType: 'episode',
    });
  });

  it('rejects a show guid', () => {
    expect(normalizePlexGuid('plex://show/5d9c07ea705b3d001f6f2be2')).toBeNull();
  });

  it('rejects a season guid', () => {
    expect(normalizePlexGuid('plex://season/5d9c07ea705b3d001f6f2be3')).toBeNull();
  });

  it('rejects a local guid', () => {
    expect(normalizePlexGuid('local://12345')).toBeNull();
  });

  it('rejects an xmltv guid', () => {
    expect(normalizePlexGuid('tv.plex.xmltv://channel-1')).toBeNull();
  });

  it('rejects a legacy agent guid', () => {
    expect(normalizePlexGuid('com.plexapp.agents.imdb://tt0111161?lang=en')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(normalizePlexGuid('')).toBeNull();
  });

  it('rejects a missing guid', () => {
    expect(normalizePlexGuid(undefined)).toBeNull();
    expect(normalizePlexGuid(null)).toBeNull();
  });
});
