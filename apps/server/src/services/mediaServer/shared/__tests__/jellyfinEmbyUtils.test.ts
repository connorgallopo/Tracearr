/**
 * Unit tests for Jellyfin/Emby shared utilities
 *
 * Tests shared utility functions used for parsing Jellyfin/Emby responses,
 * including live TV metadata, music metadata, progress calculation,
 * and content filtering.
 */

import { describe, it, expect } from 'vitest';
import {
  extractLiveTvMetadata,
  extractMusicMetadata,
  shouldFilterItem,
} from '../jellyfinEmbyUtils.js';
import { calculateProgress } from '../parserUtils.js';

describe('extractLiveTvMetadata', () => {
  it('returns undefined when no channel title available', () => {
    expect(extractLiveTvMetadata({})).toBeUndefined();
    expect(extractLiveTvMetadata({ ChannelId: '123' })).toBeUndefined();
  });

  it('extracts channel title from ChannelName', () => {
    const result = extractLiveTvMetadata({
      ChannelName: 'CNN',
      ChannelId: 'channel-123',
    });
    expect(result).toEqual({
      channelTitle: 'CNN',
      channelIdentifier: undefined,
      channelThumb: '/Items/channel-123/Images/Primary',
    });
  });

  it('falls back to Name when ChannelName not present', () => {
    const result = extractLiveTvMetadata({
      Name: 'BBC News',
      ChannelId: 'bbc-123',
    });
    expect(result).toEqual({
      channelTitle: 'BBC News',
      channelIdentifier: undefined,
      channelThumb: '/Items/bbc-123/Images/Primary',
    });
  });

  it('prefers ChannelName over Name', () => {
    const result = extractLiveTvMetadata({
      ChannelName: 'Channel Title',
      Name: 'Program Name',
      ChannelId: 'ch-123',
    });
    expect(result?.channelTitle).toBe('Channel Title');
  });

  it('extracts channel number as identifier', () => {
    const result = extractLiveTvMetadata({
      ChannelName: 'ESPN',
      ChannelNumber: '42',
      ChannelId: 'espn-123',
    });
    expect(result?.channelIdentifier).toBe('42');
  });

  it('truncates channel title to 255 characters', () => {
    const longTitle = 'A'.repeat(300);
    const result = extractLiveTvMetadata({
      ChannelName: longTitle,
    });
    expect(result?.channelTitle).toHaveLength(255);
  });

  it('truncates channel identifier to 100 characters', () => {
    const longNumber = '1'.repeat(150);
    const result = extractLiveTvMetadata({
      ChannelName: 'Test',
      ChannelNumber: longNumber,
    });
    expect(result?.channelIdentifier).toHaveLength(100);
  });

  it('returns undefined channelThumb when no ChannelId', () => {
    const result = extractLiveTvMetadata({
      ChannelName: 'Test Channel',
    });
    expect(result?.channelThumb).toBeUndefined();
  });
});

describe('extractMusicMetadata', () => {
  it('returns undefined artistName when no artist info available', () => {
    const result = extractMusicMetadata({});
    expect(result).toEqual({
      artistName: undefined,
      albumName: undefined,
      trackNumber: undefined,
      discNumber: undefined,
    });
  });

  it('extracts AlbumArtist as primary artist', () => {
    const result = extractMusicMetadata({
      AlbumArtist: 'The Beatles',
      Artists: ['John Lennon'],
    });
    expect(result.artistName).toBe('The Beatles');
  });

  it('falls back to Artists array when no AlbumArtist', () => {
    const result = extractMusicMetadata({
      Artists: ['Paul McCartney', 'Wings'],
    });
    expect(result.artistName).toBe('Paul McCartney');
  });

  it('extracts album name', () => {
    const result = extractMusicMetadata({
      AlbumArtist: 'Artist',
      Album: 'Abbey Road',
    });
    expect(result.albumName).toBe('Abbey Road');
  });

  it('extracts track and disc numbers', () => {
    const result = extractMusicMetadata({
      AlbumArtist: 'Artist',
      IndexNumber: 5,
      ParentIndexNumber: 2,
    });
    expect(result.trackNumber).toBe(5);
    expect(result.discNumber).toBe(2);
  });

  it('truncates artist name to 255 characters', () => {
    const longName = 'B'.repeat(300);
    const result = extractMusicMetadata({
      AlbumArtist: longName,
    });
    expect(result.artistName).toHaveLength(255);
  });

  it('truncates album name to 255 characters', () => {
    const longAlbum = 'C'.repeat(300);
    const result = extractMusicMetadata({
      AlbumArtist: 'Artist',
      Album: longAlbum,
    });
    expect(result.albumName).toHaveLength(255);
  });

  it('handles Artists array truncation', () => {
    const longArtist = 'D'.repeat(300);
    const result = extractMusicMetadata({
      Artists: [longArtist],
    });
    expect(result.artistName).toHaveLength(255);
  });

  it('handles null/undefined track numbers', () => {
    const result = extractMusicMetadata({
      AlbumArtist: 'Artist',
      IndexNumber: null,
      ParentIndexNumber: undefined,
    });
    expect(result.trackNumber).toBeUndefined();
    expect(result.discNumber).toBeUndefined();
  });
});

describe('calculateProgress', () => {
  it('returns 0 when duration is 0', () => {
    expect(calculateProgress(1000, 0)).toBe(0);
  });

  it('returns 0 when duration is negative', () => {
    expect(calculateProgress(1000, -100)).toBe(0);
  });

  it('returns 0 when position is 0', () => {
    expect(calculateProgress(0, 10000)).toBe(0);
  });

  it('calculates correct percentage', () => {
    expect(calculateProgress(5000, 10000)).toBe(50);
    expect(calculateProgress(7500, 10000)).toBe(75);
    expect(calculateProgress(2500, 10000)).toBe(25);
  });

  it('rounds to nearest integer', () => {
    // 3333 / 10000 = 0.3333 -> 33%
    expect(calculateProgress(3333, 10000)).toBe(33);
    // 6666 / 10000 = 0.6666 -> 67%
    expect(calculateProgress(6666, 10000)).toBe(67);
  });

  it('caps progress at 100%', () => {
    expect(calculateProgress(15000, 10000)).toBe(100);
    expect(calculateProgress(10001, 10000)).toBe(100);
  });

  it('handles edge case of position equal to duration', () => {
    expect(calculateProgress(10000, 10000)).toBe(100);
  });

  it('handles very small progress', () => {
    // 1 / 10000 = 0.0001 -> rounds to 0%
    expect(calculateProgress(1, 10000)).toBe(0);
    // 50 / 10000 = 0.005 -> rounds to 1%
    expect(calculateProgress(50, 10000)).toBe(1);
  });
});

describe('shouldFilterItem', () => {
  it('filters trailer items', () => {
    expect(shouldFilterItem({ Type: 'Trailer' })).toBe(true);
    expect(shouldFilterItem({ Type: 'trailer' })).toBe(true);
    expect(shouldFilterItem({ Type: 'TRAILER' })).toBe(true);
  });

  it('filters theme songs', () => {
    expect(shouldFilterItem({ Type: 'Audio', ExtraType: 'ThemeSong' })).toBe(true);
    expect(shouldFilterItem({ Type: 'Audio', ExtraType: 'themesong' })).toBe(true);
  });

  it('filters theme videos', () => {
    expect(shouldFilterItem({ Type: 'Video', ExtraType: 'ThemeVideo' })).toBe(true);
    expect(shouldFilterItem({ Type: 'Video', ExtraType: 'themevideo' })).toBe(true);
  });

  it('filters preroll videos by provider ID', () => {
    expect(
      shouldFilterItem({
        Type: 'Video',
        ProviderIds: { 'prerolls.video': 'some-id' },
      })
    ).toBe(true);
  });

  it('does not filter regular movies', () => {
    expect(shouldFilterItem({ Type: 'Movie', Name: 'Some Movie' })).toBe(false);
  });

  it('does not filter regular episodes', () => {
    expect(shouldFilterItem({ Type: 'Episode', Name: 'Some Episode' })).toBe(false);
  });

  it('does not filter regular music tracks', () => {
    expect(shouldFilterItem({ Type: 'Audio', Name: 'Some Song' })).toBe(false);
    expect(shouldFilterItem({ Type: 'MusicTrack', Name: 'Some Song' })).toBe(false);
  });

  it('does not filter live TV channels', () => {
    expect(shouldFilterItem({ Type: 'TvChannel', Name: 'CNN' })).toBe(false);
    expect(shouldFilterItem({ Type: 'LiveTvChannel', Name: 'ESPN' })).toBe(false);
  });

  it('handles empty objects', () => {
    expect(shouldFilterItem({})).toBe(false);
  });

  it('handles videos without preroll provider IDs', () => {
    expect(
      shouldFilterItem({
        Type: 'Video',
        ProviderIds: { tmdb: '12345', imdb: 'tt12345' },
      })
    ).toBe(false);
  });
});
