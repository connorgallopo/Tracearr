import { describe, expect, it } from 'vitest';
import { defaultBranding, renderDigest, type DigestInput } from '../index.js';

const branding = defaultBranding('Basement Plex');
const SERVER = '11111111-1111-4111-8111-111111111111';
const links = [
  {
    label: 'Basement Plex',
    url: 'https://app.plex.tv/desktop/#!/server/x/details?key=%2Flibrary%2Fmetadata%2F1',
  },
  { label: 'IMDb', url: 'https://www.imdb.com/title/tt0113277/' },
];

// The caps the assembler feeds this template, mirroring NEWSLETTER_SECTION_MAX,
// NEWSLETTER_SEASONS_PER_SHOW_MAX and NEWSLETTER_MOST_WATCHED_MAX in
// @tracearr/shared; this package does not depend on that one.
const SECTION_MAX = 12;
const SEASONS_PER_SHOW_MAX = 8;
const MOST_WATCHED_MAX = 10;

/** 40 characters, a plausible length for the external URL every Tracearr link is built on. */
const EXTERNAL = 'https://newsletters.mydomain-example.com';
const PLEX_MACHINE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const JELLYFIN = 'https://jellyfin.mydomain-example.com';

const hex = (n: number, length: number) =>
  n.toString(16).padStart(2, '0').repeat(length).slice(0, length);
const uuid = (n: number) => `${hex(n, 8)}-${hex(n, 4)}-4${hex(n, 3)}-8${hex(n, 3)}-${hex(n, 12)}`;

/** buildProxyUrl's output under the external URL, the src every hosted poster carries. */
const proxied = (thumbPath: string, n: number) => {
  const params = new URLSearchParams({
    server: SERVER,
    url: thumbPath,
    width: '360',
    height: '540',
    fallback: 'poster',
  });
  params.set('v', hex(n, 8));
  return `${EXTERNAL}/api/v1/images/proxy?${params}`;
};
const plexThumb = (n: number) => `/library/metadata/${10000 + n}/thumb/${1756800000 + n}`;
const jellyfinThumb = (n: number) => `Items/${hex(n, 32)}/Images/Primary?tag=${hex(n + 128, 32)}`;

const tracearrLink = (n: number) => ({ label: 'Tracearr', url: `${EXTERNAL}/media/${uuid(n)}` });
const imdbLink = (n: number) => ({
  label: 'IMDb',
  url: `https://www.imdb.com/title/tt${String(1000000 + n).padStart(7, '0')}/`,
});
const plexLink = (n: number) => ({
  label: 'Basement Plex',
  url: `https://app.plex.tv/desktop/#!/server/${PLEX_MACHINE}/details?key=${encodeURIComponent(`/library/metadata/${10000 + n}`)}`,
});
const jellyfinLink = (n: number) => ({
  label: 'Basement Jellyfin',
  url: `${JELLYFIN}/web/index.html#/details?id=${hex(n, 32)}`,
});

interface Variant {
  poster: (n: number) => string;
  server: (n: number) => { label: string; url: string };
}

const VARIANTS: Record<string, Variant> = {
  'hosted urls over plex thumb paths': {
    poster: (n) => proxied(plexThumb(n), n),
    server: plexLink,
  },
  'hosted urls over jellyfin image paths': {
    poster: (n) => proxied(jellyfinThumb(n), n),
    server: jellyfinLink,
  },
  'inline cid references': {
    poster: (n) => `cid:${uuid(n)}`,
    server: jellyfinLink,
  },
};

function base(over: Partial<DigestInput> = {}): DigestInput {
  return {
    subject: "What's new on Basement Plex (Sep 2, 2026)",
    intro: 'Here is what landed this week.',
    outro: 'Enjoy!',
    windowStart: 'Aug 26, 2026',
    windowEnd: 'Sep 2, 2026',
    movies: [],
    shows: [],
    artists: [],
    mostWatched: [],
    logoRef: null,
    unsubscribeUrl: '{{unsubscribe_url}}',
    viewUrl: null,
    ...over,
  };
}

/** The heaviest digest buildDigestInput can emit: every section at its cap, three links per movie and show, two per artist. */
function maxInput(variant: Variant, sectionMax = SECTION_MAX): DigestInput {
  const movies = Array.from({ length: sectionMax }, (_, i) => {
    const n = 100 + i;
    return {
      id: uuid(n),
      title: `A Reasonably Long Movie Title Number ${i}`,
      year: 1990 + i,
      posterRef: variant.poster(n),
      genres: ['Action', 'Adventure', 'Science Fiction'],
      links: [tracearrLink(n), variant.server(n), imdbLink(n)],
    };
  });
  const shows = Array.from({ length: sectionMax }, (_, i) => {
    const n = 200 + i;
    return {
      id: uuid(n),
      title: `A Long Running Television Series ${i}`,
      year: 2000 + i,
      posterRef: variant.poster(n),
      seasons: Array.from({ length: SEASONS_PER_SHOW_MAX }, (_, s) => ({
        number: s + 1,
        title: `Season ${s + 1}`,
        episodeRange: 'E01-E04, E07, E09-E12',
        episodeCount: 10,
      })),
      moreSeasons: 3,
      episodeCount: 110,
      links: [tracearrLink(n), variant.server(n), imdbLink(n)],
    };
  });
  const artists = Array.from({ length: sectionMax }, (_, i) => {
    const n = 300 + i;
    return {
      id: uuid(n),
      name: `Some Band Called ${i}`,
      albums: [
        { id: uuid(n + 50), title: 'Album Number 0 With A Long Name', year: 2010, trackCount: 12 },
      ],
      links: [tracearrLink(n), variant.server(n)],
    };
  });
  const mostWatched = Array.from({ length: MOST_WATCHED_MAX }, (_, i) => ({
    id: uuid(400 + i),
    kind: i % 2 ? ('show' as const) : ('movie' as const),
    title: `Watched Title ${i}`,
    year: 2020,
    plays: 40 - i,
  }));
  return base({ movies, shows, artists, mostWatched, logoRef: 'cid:logo' });
}

describe('renderDigest', () => {
  it('renders every section, the window, the copy, and the links', async () => {
    const out = await renderDigest(
      base({
        movies: [
          { id: 'm1', title: 'Heat', year: 1995, posterRef: 'poster:m1', genres: ['Crime'], links },
        ],
        shows: [
          {
            id: 's1',
            title: 'The Wire',
            year: 2002,
            posterRef: 'poster:s1',
            seasons: [{ number: 2, title: 'Season 2', episodeRange: 'E01-E04', episodeCount: 4 }],
            moreSeasons: 0,
            episodeCount: 4,
            links,
          },
        ],
        artists: [
          {
            id: 'a1',
            name: 'Portishead',
            albums: [{ id: 'al1', title: 'Dummy', year: 1994, trackCount: 11 }],
            links: [],
          },
        ],
        mostWatched: [{ id: 'w1', kind: 'movie', title: 'Alien', year: 1979, plays: 7 }],
      }),
      branding
    );
    expect(out.subject).toBe("What's new on Basement Plex (Sep 2, 2026)");
    expect(out.html).toContain('Aug 26, 2026');
    expect(out.html).toContain('Here is what landed this week.');
    expect(out.html).toContain('src="poster:m1"');
    expect(out.html).toContain('alt="Heat"');
    expect(out.html).toContain('Season 2');
    expect(out.html).toContain('E01-E04');
    expect(out.html).toContain('Dummy');
    expect(out.html).toContain('11 tracks');
    expect(out.html).toContain('7 plays');
    expect(out.html).toContain(`href="${links[1]!.url}"`);
    expect(out.html).toContain('href="{{unsubscribe_url}}"');
    expect(out.text).toContain('{{unsubscribe_url}}');
    expect(out.text).toContain('Heat (1995)');
    expect(out.text).not.toContain('poster:');
  });

  it('renders the empty state when every section is empty', async () => {
    const out = await renderDigest(base(), branding);
    expect(out.html).toContain('Nothing new this period');
    expect(out.html).not.toContain('<img');
  });

  it('says to reply when there is no unsubscribe link and omits a null view link', async () => {
    const out = await renderDigest(base({ unsubscribeUrl: null }), branding);
    expect(out.html).toContain('Reply to this email to unsubscribe');
    expect(out.html).not.toContain('{{unsubscribe_url}}');
    expect(out.html).not.toContain('View in browser');
  });

  it('escapes owner text', async () => {
    const out = await renderDigest(base({ intro: '<script>x</script>' }), branding);
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).not.toContain('<script>');
  });

  it('shows how many additional seasons did not make the digest', async () => {
    const out = await renderDigest(
      base({
        shows: [
          {
            id: 's2',
            title: 'Justified',
            year: 2010,
            posterRef: null,
            seasons: [{ number: 1, title: 'Season 1', episodeRange: 'E01-E03', episodeCount: 3 }],
            moreSeasons: 2,
            episodeCount: 3,
            links: [],
          },
        ],
      }),
      branding
    );
    expect(out.html).toContain('+2 more seasons');
  });

  it('renders a season with no episode range or count as just its title', async () => {
    const out = await renderDigest(
      base({
        shows: [
          {
            id: 's3',
            title: 'Chernobyl',
            year: 2019,
            posterRef: null,
            seasons: [{ number: 1, title: 'Season 1', episodeRange: '', episodeCount: 0 }],
            moreSeasons: 0,
            episodeCount: 0,
            links: [],
          },
        ],
      }),
      branding
    );
    expect(out.html).toContain('Season 1');
    expect(out.html).not.toContain(' · ');
    expect(out.html).not.toContain('(0 episodes)');
  });

  it.each(Object.entries(VARIANTS))(
    'stays under the Gmail clip budget at every maximum cap with %s',
    async (_name, variant) => {
      const out = await renderDigest(maxInput(variant), branding);
      expect(Buffer.byteLength(out.html, 'utf8')).toBeLessThan(100 * 1024);
    }
  );

  it('gives every emitted table cell an explicit background and text color', async () => {
    const out = await renderDigest(
      maxInput(VARIANTS['hosted urls over plex thumb paths']!),
      branding
    );
    const cells = out.html.match(/<td[^>]*>/g) ?? [];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell).toMatch(/background-color:/);
      expect(cell).toMatch(/(?<!-)color:/);
    }
  });
});
