import { describe, expect, it } from 'vitest';
import type { ImportKeyIdentity } from '../../../jobs/poller/database.js';
import {
  AGREEMENT_CASES,
  NORMALIZATION_CASES,
  REPAIR_CASES,
  SHOW_NORMALIZATION_CASES,
} from '../../../test/keyRuleCases.js';
import {
  comparableTitle,
  importIdentityByKey,
  keyAgreesWithPlay,
  libraryKeyProvablyReused,
  linkDisagreesWithPlay,
  normalizeShowTitle,
  parseHistoryGuid,
} from '../libraryKeyMatch.js';

const item = { mediaType: 'movie', title: 'Harbor Gone', year: 2001 };

describe('libraryKeyProvablyReused', () => {
  it('keeps a key match whose title or year still agrees within the resolver tolerance', () => {
    expect(
      libraryKeyProvablyReused(item, { mediaType: 'movie', title: 'Harbour Gone', year: 2001 })
    ).toBe(false);
    expect(
      libraryKeyProvablyReused(item, { mediaType: 'movie', title: 'HARBOR GONE!', year: 1800 })
    ).toBe(false);
    expect(
      libraryKeyProvablyReused(item, { mediaType: 'movie', title: 'Other Film', year: 2002 })
    ).toBe(false);
    expect(
      libraryKeyProvablyReused(item, { mediaType: 'unknown', title: 'Other Film', year: null })
    ).toBe(false);
    expect(
      libraryKeyProvablyReused(
        { ...item, year: null },
        { mediaType: 'movie', title: 'Other Film', year: 1990 }
      )
    ).toBe(false);
  });

  it('refuses a key held by another media type, or by a title and year that both disagree', () => {
    expect(
      libraryKeyProvablyReused(item, { mediaType: 'episode', title: 'Harbor Gone', year: 2001 })
    ).toBe(true);
    expect(
      libraryKeyProvablyReused(item, { mediaType: 'movie', title: 'Other Film', year: 1990 })
    ).toBe(true);
  });
});

describe('keyAgreesWithPlay', () => {
  it.each(AGREEMENT_CASES)('$name', ({ item, play, agrees }) => {
    expect(keyAgreesWithPlay(item, play)).toBe(agrees);
  });
});

describe('linkDisagreesWithPlay', () => {
  it.each(REPAIR_CASES)('$name', ({ link, play, clause }) => {
    expect(linkDisagreesWithPlay(link, play)).toBe(clause);
  });
});

describe('comparableTitle', () => {
  it.each(NORMALIZATION_CASES)('$raw', ({ raw, normalized }) => {
    expect(comparableTitle(raw)).toBe(normalized);
  });
});

describe('normalizeShowTitle', () => {
  it.each(SHOW_NORMALIZATION_CASES)('$raw', ({ raw, normalized }) => {
    expect(normalizeShowTitle(raw)).toBe(normalized);
  });
});

it("importIdentityByKey keeps the provably-reused rule when the server's keys are not reused", () => {
  const identity: ImportKeyIdentity = {
    mediaId: 'media-blacklist-s7e9',
    showMediaId: 'media-blacklist',
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    parentRatingKey: null,
    grandparentRatingKey: null,
    itemMediaType: 'episode',
    itemTitle: 'Les Fleurs du Mal',
    itemYear: 2019,
    itemGuid: null,
    itemShowTitle: 'The Blacklist',
    itemSeason: 7,
    itemEpisode: 9,
    showTvdbId: null,
    showTmdbId: null,
  };
  const play = {
    mediaType: 'episode',
    title: 'The Zweihander',
    year: 2020,
    grandparentTitle: 'Forged in Fire',
    seasonNumber: 7,
    episodeNumber: 17,
  };

  expect(importIdentityByKey(identity, play, false)).toBe(identity);
  expect(importIdentityByKey(identity, play, true)).toBeUndefined();
});

describe('parseHistoryGuid', () => {
  it('parses legacy tvdb agent guids at series level', () => {
    expect(parseHistoryGuid('com.plexapp.agents.thetvdb://121361/6/1?lang=en')).toEqual({
      tvdbId: 121361,
    });
  });
  it('parses legacy tmdb agent guids', () => {
    expect(parseHistoryGuid('com.plexapp.agents.themoviedb://584?lang=en')).toEqual({
      tmdbId: 584,
    });
  });
  it('parses legacy imdb agent guids', () => {
    expect(parseHistoryGuid('com.plexapp.agents.imdb://tt0322259?lang=en')).toEqual({
      imdbId: 'tt0322259',
    });
  });
  it('returns empty for new-style plex guids and null', () => {
    expect(parseHistoryGuid('plex://movie/5d776b59ad5437001f79c6f8')).toEqual({});
    expect(parseHistoryGuid(null)).toEqual({});
  });
});
