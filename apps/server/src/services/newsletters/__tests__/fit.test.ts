import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDigest, type EmailBranding } from '@tracearr/emails';

const mockDebug = vi.fn();
const mockWarn = vi.fn();
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    debug: (...args: unknown[]) => mockDebug(...args),
    info: vi.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: vi.fn(),
  }),
}));

import { sectionItemCounts, type DigestData } from '../assemble.js';
import {
  EMAIL_CLIP_FIT_BYTES,
  TRIM_ORDER,
  deliveredBytes,
  dropLastItem,
  fitDigest,
  renderDigestToFit,
  sectionToTrim,
} from '../fit.js';
import {
  UNSUBSCRIBE_PLACEHOLDER,
  VIEW_PLACEHOLDER,
  buildDigestInput,
  type DigestInputOptions,
} from '../render.js';
import { EXTERNAL_URL, JELLYFIN_SERVER, heaviestDigest, heaviestRuns } from './heaviestDigest.js';

const opts = (): DigestInputOptions => ({
  subject: "What's new on Basement Jellyfin (Sep 4, 2026)",
  intro: heaviestRuns(),
  outro: heaviestRuns(),
  windowStart: 'Aug 28, 2026',
  windowEnd: 'Sep 4, 2026',
  logoRef: `${EXTERNAL_URL}/api/v1/images/logo`,
  unsubscribeUrl: UNSUBSCRIBE_PLACEHOLDER,
  viewUrl: VIEW_PLACEHOLDER,
  externalUrl: EXTERNAL_URL,
  tracearrLinks: true,
  serversById: new Map([[JELLYFIN_SERVER.id, JELLYFIN_SERVER]]),
  memberSend: true,
});
/** The branding block at its schema limits: 500-character footer and postal address. */
const branding: EmailBranding = {
  senderName: 'Basement Jellyfin',
  accentColor: '#0ea0b3',
  footerText: 'f'.repeat(500),
  postalAddress: 'p'.repeat(500),
};
const delivery = { newsletterId: 'n-1', mode: 'hosted' as const, externalUrl: EXTERNAL_URL };
const totalItems = (data: DigestData): number =>
  Object.values(sectionItemCounts(data)).reduce((sum, n) => sum + n, 0);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sectionToTrim', () => {
  it('picks the section with the most items and breaks ties in the fixed order', () => {
    const { data } = heaviestDigest();
    expect(TRIM_ORDER).toEqual(['shows', 'movies', 'albums', 'mostWatched']);
    expect(sectionToTrim(data)).toBe('shows');
    const one = dropLastItem(data, 'shows');
    expect(sectionToTrim(one)).toBe('movies');
    expect(sectionToTrim(dropLastItem(one, 'movies'))).toBe('albums');
    const thin = {
      ...data,
      movies: data.movies.slice(0, 2),
      shows: [],
      artists: data.artists.slice(0, 1),
    };
    expect(sectionToTrim(thin)).toBe('mostWatched');
  });

  it('returns null when every section is empty', () => {
    const { data } = heaviestDigest();
    expect(
      sectionToTrim({ ...data, movies: [], shows: [], artists: [], mostWatched: [] })
    ).toBeNull();
  });
});

describe('dropLastItem', () => {
  it('removes the last card of a flat section and leaves the input and its counts alone', () => {
    const { data } = heaviestDigest();
    const out = dropLastItem(data, 'movies');
    expect(out.movies).toHaveLength(11);
    expect(out.movies[10]?.cardId).toBe(data.movies[10]?.cardId);
    expect(out.counts).toEqual(data.counts);
    expect(data.movies).toHaveLength(12);
    expect(dropLastItem(data, 'shows').shows).toHaveLength(11);
    expect(dropLastItem(data, 'mostWatched').mostWatched).toHaveLength(9);
  });

  it('removes the last album of the last artist and drops an artist left with none', () => {
    const { data } = heaviestDigest();
    const first = data.artists[0]!;
    const two: DigestData = {
      ...data,
      artists: [
        { ...first, albums: [first.albums[0]!, data.artists[1]!.albums[0]!] },
        data.artists[2]!,
      ],
    };
    const once = dropLastItem(two, 'albums');
    expect(once.artists).toHaveLength(1);
    expect(once.artists[0]?.albums).toHaveLength(2);
    const twice = dropLastItem(once, 'albums');
    expect(twice.artists).toHaveLength(1);
    expect(twice.artists[0]?.albums.map((a) => a.cardId)).toEqual([first.albums[0]!.cardId]);
    expect(two.artists[0]?.albums).toHaveLength(2);
  });
});

describe('fitDigest', () => {
  const sized =
    (perShow: number, perMovie: number, perAlbum: number, perWatched: number) =>
    async (data: DigestData) => {
      const c = sectionItemCounts(data);
      const bytes =
        90_000 +
        c.shows * perShow +
        c.movies * perMovie +
        c.albums * perAlbum +
        c.mostWatched * perWatched;
      return { rendered: { subject: 's', html: 'x'.repeat(bytes), text: '' }, bytes };
    };

  it('removes one item per render from the largest section until the measure fits', async () => {
    const { data } = heaviestDigest();
    const result = await fitDigest(data, sized(500, 400, 300, 100));
    expect(result.trimmed).toEqual({ movies: 3, shows: 4, albums: 3, mostWatched: 1 });
    expect(result.renders).toBe(12);
    expect(result.bytes).toBe(101_200);
    expect(result.rendered.html).toHaveLength(101_200);
    expect(sectionItemCounts(result.data)).toEqual({
      movies: 9,
      shows: 8,
      albums: 9,
      mostWatched: 9,
    });
    expect(result.data.counts).toEqual(data.counts);
  });

  it('stops after every item is gone when nothing fits, returning the last render', async () => {
    const { data } = heaviestDigest();
    const never = async (current: DigestData) => ({
      rendered: { subject: 's', html: '', text: '' },
      bytes: 200_000 + totalItems(current),
    });
    const result = await fitDigest(data, never);
    expect(result.trimmed).toEqual({ movies: 12, shows: 12, albums: 12, mostWatched: 10 });
    expect(result.renders).toBe(47);
    expect(result.bytes).toBe(200_000);
    expect(sectionItemCounts(result.data)).toEqual({
      movies: 0,
      shows: 0,
      albums: 0,
      mostWatched: 0,
    });
  });
});

describe('renderDigestToFit', () => {
  it('measures what delivery substitutes: hosted poster urls weigh more than cid references', async () => {
    const { data, posters } = heaviestDigest();
    const raw = await renderDigest(buildDigestInput(data, posters, opts()), branding);
    expect(deliveredBytes(raw.html, posters, 'inline', EXTERNAL_URL)).toBeLessThan(
      deliveredBytes(raw.html, posters, 'hosted', EXTERNAL_URL)
    );
  });

  it('brings the heaviest digest the assembler can produce under the budget by trimming shows, movies and albums and says so', async () => {
    const { data, posters } = heaviestDigest();
    const result = await renderDigestToFit(data, posters, opts(), branding, delivery);
    expect(result.bytes).toBeLessThanOrEqual(EMAIL_CLIP_FIT_BYTES);
    // Measured 2026-09-07: album covers and most-watched posters tie movies, shows and albums
    // at 12 items each, so the largest-section tie-break interleaves all three instead of
    // stopping at shows alone.
    expect(result.trimmed).toEqual({ movies: 2, shows: 3, albums: 2, mostWatched: 0 });
    expect(result.renders).toBe(8);
    expect(result.data.shows).toHaveLength(9);
    expect(result.data.counts).toEqual(data.counts);
    expect(result.rendered.html).toContain('+11 more shows');
    expect(result.rendered.html).toContain('+20 more movies');
    expect(result.rendered.html).toContain('+10 more albums');
    expect(result.rendered.html).not.toContain('more titles');
    expect(result.rendered.html).not.toContain('rel="preload"');
    expect(deliveredBytes(result.rendered.html, posters, 'hosted', EXTERNAL_URL)).toBe(
      result.bytes
    );
    expect(mockDebug).toHaveBeenCalledWith('Trimmed the digest to fit the clip budget', {
      newsletterId: 'n-1',
      trimmed: { movies: 2, shows: 3, albums: 2, mostWatched: 0 },
      bytes: result.bytes,
      renders: 8,
    });
  });

  it('passes a light digest through untouched, byte for byte', async () => {
    const { data, posters } = heaviestDigest();
    const light: DigestData = {
      ...data,
      movies: data.movies.slice(0, 1),
      shows: [],
      artists: [],
      mostWatched: [],
      counts: { movies: 1, shows: 0, episodes: 0, albums: 0, mostWatched: 0 },
    };
    const direct = await renderDigest(buildDigestInput(light, posters, opts()), branding);
    const result = await renderDigestToFit(light, posters, opts(), branding, delivery);
    expect(result.rendered.html).toBe(direct.html);
    expect(result.rendered.text).toBe(direct.text);
    expect(result.trimmed).toEqual({ movies: 0, shows: 0, albums: 0, mostWatched: 0 });
    expect(result.renders).toBe(1);
    expect(result.data).toBe(light);
    expect(mockDebug).not.toHaveBeenCalled();
  });

  it('drops an album-less artist card without crediting it as a removed album', async () => {
    const { data, posters } = heaviestDigest();
    // groupDigest no longer emits an album-less artist card, but fit.ts must still trim one safely if it ever sees one; give the first artist a second album so albums outnumbers shows and movies, forcing sectionToTrim to pick 'albums' first.
    const extraAlbum = {
      cardId: 'extra-album',
      serverId: JELLYFIN_SERVER.id,
      serverName: JELLYFIN_SERVER.name,
      serverType: 'jellyfin',
      ratingKey: 'extra-album-key',
      mediaId: null,
      imdbId: null,
      thumbPath: null,
      mirrors: [],
      title: 'Bonus Album',
      year: 2015,
      trackCount: 8,
    };
    const artists = data.artists.map((a, i) =>
      i === 0 ? { ...a, albums: [...a.albums, extraAlbum] } : a
    );
    const emptyArtist = {
      cardId: 'artist-empty',
      serverId: JELLYFIN_SERVER.id,
      serverName: JELLYFIN_SERVER.name,
      serverType: 'jellyfin',
      ratingKey: 'empty-artist-key',
      mediaId: null,
      imdbId: null,
      thumbPath: null,
      mirrors: [],
      name: 'No Albums Band',
      albums: [] as DigestData['artists'][number]['albums'],
    };
    const heavy: DigestData = { ...data, artists: [...artists, emptyArtist] };
    const result = await renderDigestToFit(heavy, posters, opts(), branding, delivery);
    expect(result.data.artists.some((a) => a.cardId === 'artist-empty')).toBe(false);
    // Measured 2026-09-10: the extra album starts the tie-break on albums, but the same
    // three-way tie as the previous test still interleaves movies and shows into the trim.
    expect(result.trimmed).toEqual({ movies: 2, shows: 3, albums: 3, mostWatched: 0 });
    expect(sectionItemCounts(result.data)).toEqual({
      movies: 10,
      shows: 9,
      albums: 10,
      mostWatched: 10,
    });
    expect(result.rendered.html).toContain('+10 more albums');
  });

  it('warns with the final bytes and the budget when trimming everything still leaves it over', async () => {
    const { data, posters } = heaviestDigest();
    const heavyBranding: EmailBranding = {
      ...branding,
      // Trimming can only remove cards; an oversized footer stays no matter what's cut, so the loop exhausts its bound and the render never gets under budget.
      footerText: 'f'.repeat(150_000),
    };
    const result = await renderDigestToFit(data, posters, opts(), heavyBranding, delivery);
    expect(result.bytes).toBeGreaterThan(EMAIL_CLIP_FIT_BYTES);
    expect(result.renders).toBe(47);
    expect(mockDebug).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'Digest still exceeds the clip budget after trimming everything it could',
      { newsletterId: 'n-1', bytes: result.bytes, budget: EMAIL_CLIP_FIT_BYTES }
    );
  });
});
