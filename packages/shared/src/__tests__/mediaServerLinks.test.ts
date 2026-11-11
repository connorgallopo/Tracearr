import { describe, it, expect } from 'vitest';
import {
  buildMediaServerItemUrl,
  isPubliclyRoutableUrl,
  memberFacingUrl,
  type MediaServerItemLinkInput,
} from '../mediaServerLinks.js';

const PLEX_MACHINE = '02aede436384ae67d1d1dc879dcd69f8504c27ca';
const EMBY_SERVER = 'a1c97fc391d842678fb3f3a4cb42e185';

describe('buildMediaServerItemUrl', () => {
  it('sends Plex through app.plex.tv with the encoded metadata key', () => {
    expect(
      buildMediaServerItemUrl({
        serverType: 'plex',
        baseUrl: 'http://192.168.1.10:32400',
        ratingKey: '2733',
        machineIdentifier: PLEX_MACHINE,
      })
    ).toBe(
      `https://app.plex.tv/desktop/#!/server/${PLEX_MACHINE}/details?key=%2Flibrary%2Fmetadata%2F2733`
    );
  });

  it('builds an Emby link with the bang prefix and its serverId', () => {
    expect(
      buildMediaServerItemUrl({
        serverType: 'emby',
        baseUrl: 'http://media.example.com:8096',
        ratingKey: '2539',
        machineIdentifier: EMBY_SERVER,
      })
    ).toBe(`http://media.example.com:8096/web/index.html#!/item?id=2539&serverId=${EMBY_SERVER}`);
  });

  it('builds a Jellyfin link with no bang and no serverId', () => {
    expect(
      buildMediaServerItemUrl({
        serverType: 'jellyfin',
        baseUrl: 'http://media.example.com:8096',
        ratingKey: 'bf01da2708ae716a7d2bd441376de12f',
      })
    ).toBe(
      'http://media.example.com:8096/web/index.html#/details?id=bf01da2708ae716a7d2bd441376de12f'
    );
  });

  it('builds a tofa link through app.tofa.tv, whatever the server address', () => {
    expect(
      buildMediaServerItemUrl({
        serverType: 'tofa',
        baseUrl: 'http://media.example.com:33333/',
        ratingKey: '4c2e8a1f-6b3d-4e97-a5c0-9d1f7b2e8a63',
        mediaType: 'movie',
      })
    ).toBe('https://app.tofa.tv/media/4c2e8a1f-6b3d-4e97-a5c0-9d1f7b2e8a63');
  });

  it('opens a tofa episode or season on its show page by number', () => {
    const episode: MediaServerItemLinkInput = {
      serverType: 'tofa',
      baseUrl: 'http://media.example.com:33333',
      ratingKey: '9b7d3f1e-2c8a-4a65-b0e4-7f3c1d9a5e28',
      mediaType: 'episode',
      showRatingKey: '4c2e8a1f-6b3d-4e97-a5c0-9d1f7b2e8a63',
      seasonNumber: 29,
      episodeNumber: 2,
    };
    const show = 'https://app.tofa.tv/media/4c2e8a1f-6b3d-4e97-a5c0-9d1f7b2e8a63';
    expect(buildMediaServerItemUrl(episode)).toBe(`${show}?season=29&episode=2`);
    expect(buildMediaServerItemUrl({ ...episode, mediaType: 'season' })).toBe(`${show}?season=29`);
    expect(buildMediaServerItemUrl({ ...episode, seasonNumber: 0 })).toBe(
      `${show}?season=0&episode=2`
    );
    expect(buildMediaServerItemUrl({ ...episode, seasonNumber: null })).toBe(show);
  });

  it('links a tofa episode to its show, and not at all when the show is unknown', () => {
    const episode: MediaServerItemLinkInput = {
      serverType: 'tofa',
      baseUrl: 'http://media.example.com:33333',
      ratingKey: '9b7d3f1e-2c8a-4a65-b0e4-7f3c1d9a5e28',
      mediaType: 'episode',
    };
    expect(
      buildMediaServerItemUrl({
        ...episode,
        showRatingKey: '4c2e8a1f-6b3d-4e97-a5c0-9d1f7b2e8a63',
      })
    ).toBe('https://app.tofa.tv/media/4c2e8a1f-6b3d-4e97-a5c0-9d1f7b2e8a63');
    expect(buildMediaServerItemUrl({ ...episode, showRatingKey: null })).toBeNull();
  });

  it('does not double the slash when the configured url has a trailing one', () => {
    expect(
      buildMediaServerItemUrl({
        serverType: 'jellyfin',
        baseUrl: 'http://media.example.com:8096/',
        ratingKey: 'abc',
      })
    ).toBe('http://media.example.com:8096/web/index.html#/details?id=abc');
  });

  it('returns null for Plex and Emby when the server identifier is unknown', () => {
    expect(
      buildMediaServerItemUrl({ serverType: 'plex', baseUrl: 'http://x:32400', ratingKey: '1' })
    ).toBeNull();
    expect(
      buildMediaServerItemUrl({ serverType: 'emby', baseUrl: 'http://x:8096', ratingKey: '1' })
    ).toBeNull();
  });

  it('returns null without a rating key', () => {
    expect(
      buildMediaServerItemUrl({
        serverType: 'jellyfin',
        baseUrl: 'http://x:8096',
        ratingKey: '',
      })
    ).toBeNull();
  });
});

describe('isPubliclyRoutableUrl', () => {
  it.each([
    'http://192.168.1.10:32400',
    'http://10.0.0.5:8096',
    'http://172.16.4.2:8096',
    'http://172.31.255.1',
    'http://127.0.0.1:8096',
    'http://localhost:8096',
    'http://100.104.221.111:8096',
    'http://169.254.10.1',
    'http://jellyfin:8096',
    'http://nas.local:8096',
    'https://mini.tail1234.ts.net',
    'http://[::1]:8096',
    'http://[fd00::1]:8096',
    'http://[fe80::1]:8096',
    'not a url',
    '',
  ])('treats %s as private', (url) => {
    expect(isPubliclyRoutableUrl(url)).toBe(false);
  });

  it.each([
    'https://media.example.com',
    'http://media.example.com:8096/',
    'http://172.32.0.1',
    'http://100.128.0.1',
    'https://8.8.8.8',
    'http://[2001:db8::1]:8096',
  ])('treats %s as public', (url) => {
    expect(isPubliclyRoutableUrl(url)).toBe(true);
  });
});

describe('memberFacingUrl', () => {
  it('prefers the public address, falls back to a public server url, and yields nothing otherwise', () => {
    expect(
      memberFacingUrl({
        url: 'http://192.168.1.20:8096',
        publicUrl: 'https://jellyfin.example.com',
      })
    ).toBe('https://jellyfin.example.com');
    expect(
      memberFacingUrl({
        url: 'https://lan-name.example.com',
        publicUrl: 'https://members.example.com',
      })
    ).toBe('https://members.example.com');
    expect(memberFacingUrl({ url: 'https://lan-name.example.com', publicUrl: null })).toBe(
      'https://lan-name.example.com'
    );
    expect(memberFacingUrl({ url: 'https://lan-name.example.com' })).toBe(
      'https://lan-name.example.com'
    );
    expect(memberFacingUrl({ url: 'http://192.168.1.20:8096', publicUrl: null })).toBeNull();
    expect(
      memberFacingUrl({ url: 'https://lan-name.example.com', publicUrl: 'http://10.0.0.5:8096' })
    ).toBeNull();
  });
});
