import { describe, expect, it } from 'vitest';
import { defaultBranding, renderDigest, type DigestInput } from '../index.js';

const branding = defaultBranding('Basement Plex');
const SERVER = '11111111-1111-4111-8111-111111111111';
const hosted = (n: number) =>
  `https://tracearr.example.com/api/v1/images/proxy?server=${SERVER}&url=%2Flibrary%2Fmetadata%2F${n}%2Fthumb&width=360&height=540&fallback=poster&v=abcdef12`;
const links = [
  {
    label: 'Basement Plex',
    url: 'https://app.plex.tv/desktop/#!/server/x/details?key=%2Flibrary%2Fmetadata%2F1',
  },
  { label: 'IMDb', url: 'https://www.imdb.com/title/tt0113277/' },
];

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

function maxInput(): DigestInput {
  const movies = Array.from({ length: 15 }, (_, i) => ({
    id: `m${i}`,
    title: `A Reasonably Long Movie Title Number ${i}`,
    year: 1990 + i,
    posterRef: hosted(1000 + i),
    genres: ['Action', 'Adventure', 'Science Fiction'],
    links: [links[0]!],
  }));
  const shows = Array.from({ length: 15 }, (_, i) => ({
    id: `s${i}`,
    title: `A Long Running Television Series ${i}`,
    year: 2000 + i,
    posterRef: hosted(2000 + i),
    seasons: Array.from({ length: 8 }, (_, s) => ({
      number: s + 1,
      title: `Season ${s + 1}`,
      episodeRange: 'E01-E04, E07, E09-E12',
      episodeCount: 10,
    })),
    moreSeasons: 3,
    episodeCount: 110,
    links: [links[0]!],
  }));
  const artists = Array.from({ length: 15 }, (_, i) => ({
    id: `a${i}`,
    name: `Some Band Called ${i}`,
    albums: [
      {
        id: `al${i}0`,
        title: `Album Number 0 With A Long Name`,
        year: 2010,
        posterRef: hosted(3000 + i),
        trackCount: 12,
      },
    ],
    links: [links[0]!],
  }));
  const mostWatched = Array.from({ length: 10 }, (_, i) => ({
    id: `w${i}`,
    kind: i % 2 ? ('show' as const) : ('movie' as const),
    title: `Watched Title ${i}`,
    year: 2020,
    posterRef: hosted(4000 + i),
    plays: 40 - i,
  }));
  return base({ movies, shows, artists, mostWatched, logoRef: hosted(1) });
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
            albums: [{ id: 'al1', title: 'Dummy', year: 1994, posterRef: null, trackCount: 11 }],
            links: [],
          },
        ],
        mostWatched: [
          { id: 'w1', kind: 'movie', title: 'Alien', year: 1979, posterRef: null, plays: 7 },
        ],
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

  it('stays under the Gmail clip budget at every maximum cap with hosted urls', async () => {
    const out = await renderDigest(maxInput(), branding);
    expect(Buffer.byteLength(out.html, 'utf8')).toBeLessThan(100 * 1024);
  });

  it('gives every emitted table cell an explicit background and text color', async () => {
    const out = await renderDigest(maxInput(), branding);
    const cells = out.html.match(/<td[^>]*>/g) ?? [];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell).toMatch(/background-color:/);
      expect(cell).toMatch(/(?<!-)color:/);
    }
  });
});
