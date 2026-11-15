import { describe, expect, it } from 'vitest';
import { getDeviceDisplayName, getMediaDisplay, getMediaLinks } from './utils';

describe('getDeviceDisplayName', () => {
  it('prefers the name the client gave itself', () => {
    expect(
      getDeviceDisplayName({
        playerName: "Emily's Fire TV",
        product: 'Plex for Amazon FireTV',
        device: 'AFTMM',
        platform: 'Fire TV',
      })
    ).toBe("Emily's Fire TV");
  });

  it('falls back to the app and the hardware it runs on', () => {
    expect(
      getDeviceDisplayName({ playerName: null, product: 'Plex for Roku', device: '50S425' })
    ).toBe('Plex for Roku - 50S425');
  });

  it('does not repeat hardware the app name already contains', () => {
    expect(getDeviceDisplayName({ playerName: null, product: 'Plex for iOS', device: 'iOS' })).toBe(
      'Plex for iOS'
    );
  });

  it('falls back to the platform, then to nothing at all', () => {
    expect(getDeviceDisplayName({ platform: 'Roku' })).toBe('Roku');
    expect(getDeviceDisplayName({})).toBeNull();
  });
});

describe('getMediaLinks', () => {
  it('links a movie title to its media page', () => {
    expect(getMediaLinks({ mediaType: 'movie', mediaTitle: 'Heat', mediaId: 'm1' })).toEqual({
      title: '/media/m1',
      subtitle: null,
    });
  });

  it('links an episode show name to the show and the episode line to the episode', () => {
    expect(
      getMediaLinks({
        mediaType: 'episode',
        mediaTitle: 'Pilot',
        grandparentTitle: 'Lost',
        mediaId: 'ep1',
        showMediaId: 'show1',
      })
    ).toEqual({ title: '/media/show1', subtitle: '/media/ep1' });
  });

  it('links nothing when the ids are missing', () => {
    expect(
      getMediaLinks({
        mediaType: 'episode',
        mediaTitle: 'Pilot',
        grandparentTitle: 'Lost',
        mediaId: null,
        showMediaId: null,
      })
    ).toEqual({ title: null, subtitle: null });
  });
});

describe('getMediaDisplay for live TV', () => {
  it('names the show, episode and channel of a live episode', () => {
    expect(
      getMediaDisplay({
        mediaType: 'live',
        mediaTitle: 'Episode 14',
        grandparentTitle: 'Friends',
        seasonNumber: 3,
        episodeNumber: 14,
        channelTitle: 'TBS',
      })
    ).toEqual({ title: 'Friends', subtitle: 'S03 E14 · Episode 14 · TBS' });
  });

  it('puts the channel under a program that is not an episode', () => {
    expect(
      getMediaDisplay({ mediaType: 'live', mediaTitle: 'News at 3', channelTitle: 'NBC 5' })
    ).toEqual({ title: 'News at 3', subtitle: 'NBC 5' });
  });

  it('does not repeat a channel that is also the title', () => {
    expect(getMediaDisplay({ mediaType: 'live', mediaTitle: 'CNN', channelTitle: 'CNN' })).toEqual({
      title: 'CNN',
      subtitle: null,
    });
  });
});
