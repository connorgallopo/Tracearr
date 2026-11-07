import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db/client.js', () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from '../../../db/client.js';
import { hasKnownImage, parentArtFor, posterOf } from '../posterArt.js';
import type { MediaLibraryItem } from '../../mediaServer/types.js';

const SERVER = '33333333-3333-4333-8333-333333333333';
const ALBUM_ART = '/Items/100/Images/Primary?tag=cover';
const SHOW_POSTER = '/library/metadata/50/thumb/1700000000';

const item = (
  ratingKey: string,
  mediaType: MediaLibraryItem['mediaType'],
  thumbPath?: string,
  parentRatingKey?: string,
  grandparentRatingKey?: string
): MediaLibraryItem => ({
  ratingKey,
  title: ratingKey,
  mediaType,
  addedAt: new Date(0),
  thumbPath,
  parentRatingKey,
  grandparentRatingKey,
});

let selected: { ratingKey: string; thumbPath: string | null; dominantColor: string | null }[];

beforeEach(() => {
  selected = [];
  vi.mocked(db.select).mockReset();
  vi.mocked(db.select).mockReturnValue({
    from: () => ({ where: async () => selected }),
  } as never);
});

describe('hasKnownImage', () => {
  it('trusts non-Items paths and tagged Items paths only', () => {
    expect(hasKnownImage('/library/metadata/1/thumb/2')).toBe(true);
    expect(hasKnownImage(ALBUM_ART)).toBe(true);
    expect(hasKnownImage('/Items/100/Images/Primary')).toBe(false);
  });
});

describe('parentArtFor', () => {
  it('reads albums from the batch first and skips the db when the batch covers every track', async () => {
    const art = await parentArtFor(SERVER, [
      item('100', 'album', ALBUM_ART, '1'),
      item('101', 'track', '/Items/101/Images/Primary?tag=a', '100'),
      item('200', 'album', '/Items/200/Images/Primary', '1'),
    ]);
    expect(art).toEqual(new Map([['100', { thumbPath: ALBUM_ART, dominantColor: null }]]));
    expect(db.select).not.toHaveBeenCalled();
  });

  it('looks up the albums of tracks the batch lacks and drops artless ones', async () => {
    selected = [{ ratingKey: '300', thumbPath: ALBUM_ART, dominantColor: '#223344' }];
    const art = await parentArtFor(SERVER, [
      item('301', 'track', '/Items/301/Images/Primary?tag=b', '300'),
      item('401', 'track', '/Items/401/Images/Primary?tag=c', '400'),
      item('500', 'episode', '/Items/500/Images/Primary?tag=d', '50'),
    ]);
    expect(art).toEqual(new Map([['300', { thumbPath: ALBUM_ART, dominantColor: '#223344' }]]));
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("looks up an episode's show by its grandparent key, with the show's color", async () => {
    selected = [{ ratingKey: '50', thumbPath: SHOW_POSTER, dominantColor: '#101820' }];
    const art = await parentArtFor(SERVER, [
      item('52', 'episode', '/library/metadata/52/thumb/1', '51', '50'),
    ]);
    expect(art).toEqual(new Map([['50', { thumbPath: SHOW_POSTER, dominantColor: '#101820' }]]));
  });
});

describe('posterOf', () => {
  const art = new Map([['50', { thumbPath: SHOW_POSTER, dominantColor: '#101820' }]]);

  it("gives an episode its show's poster, or none rather than its own still", () => {
    expect(
      posterOf(item('52', 'episode', '/library/metadata/52/thumb/1', '51', '50'), art)
    ).toEqual({ thumbPath: SHOW_POSTER, dominantColor: '#101820' });
    expect(
      posterOf(item('62', 'episode', '/library/metadata/62/thumb/1', '61', '60'), art)
    ).toEqual({ thumbPath: null, dominantColor: null });
  });

  it('keeps the own art of a track whose album has none, and of everything else', () => {
    expect(posterOf(item('401', 'track', '/Items/401/Images/Primary?tag=c', '400'), art)).toEqual({
      thumbPath: '/Items/401/Images/Primary?tag=c',
      dominantColor: null,
    });
    expect(posterOf(item('50', 'show', SHOW_POSTER), art)).toEqual({
      thumbPath: SHOW_POSTER,
      dominantColor: null,
    });
  });
});
