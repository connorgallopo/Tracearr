import { describe, expect, it } from 'vitest';
import { defaultBranding, renderDigest, type DigestInput, type RichTextDoc } from '../index.js';

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

/** Mirrors EMAIL_RICH_TEXT_MAX_WEIGHT = 3500 in @tracearr/shared: eight bold linked list items of 100 characters weigh 3332, nineteen one-character bold italic linked runs weigh 3406. */
const RICH_HREF = `https://example.com/${'x'.repeat(20)}`;
const paragraphDoc = (text: string): RichTextDoc => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const heaviestList: RichTextDoc = {
  type: 'doc',
  content: [
    {
      type: 'bulletList',
      content: Array.from({ length: 8 }, () => ({
        type: 'listItem' as const,
        content: [
          {
            type: 'paragraph' as const,
            content: [
              {
                type: 'text' as const,
                text: 'x'.repeat(100),
                marks: [
                  { type: 'bold' as const },
                  { type: 'link' as const, attrs: { href: RICH_HREF } },
                ],
              },
            ],
          },
        ],
      })),
    },
  ],
};
const heaviestRuns: RichTextDoc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: Array.from({ length: 19 }, () => ({
        type: 'text' as const,
        text: 'x',
        marks: [
          { type: 'bold' as const },
          { type: 'italic' as const },
          { type: 'link' as const, attrs: { href: RICH_HREF } },
        ],
      })),
    },
  ],
};

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
    intro: paragraphDoc('Here is what landed this week.'),
    outro: paragraphDoc('Enjoy!'),
    windowStart: 'Aug 26, 2026',
    windowEnd: 'Sep 2, 2026',
    movies: [],
    shows: [],
    artists: [],
    mostWatched: [],
    moreMovies: 0,
    moreShows: 0,
    moreAlbums: 0,
    moreWatched: 0,
    episodes: 0,
    logoRef: null,
    unsubscribeUrl: '{{unsubscribe_url}}',
    viewUrl: null,
    multiServer: false,
    serverNames: ['Basement Plex'],
    memberSend: true,
    ...over,
  };
}

/** The heaviest digest buildDigestInput can emit: every section at its cap, each cap's "+N more" line at the window limit (5,000 rows minus the cap), three links per movie and show, two per artist and most-watched card. */
function maxInput(
  variant: Variant,
  copy: { intro: RichTextDoc; outro: RichTextDoc },
  sectionMax = SECTION_MAX
): DigestInput {
  const movies = Array.from({ length: sectionMax }, (_, i) => {
    const n = 100 + i;
    return {
      id: uuid(n),
      title: `A Reasonably Long Movie Title Number ${i}`,
      year: 1990 + i,
      posterRef: variant.poster(n),
      genres: ['Action', 'Adventure', 'Science Fiction'],
      serverName: 'Basement Plex',
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
        whole: false,
      })),
      moreSeasons: 3,
      episodeCount: 110,
      serverName: 'Basement Plex',
      links: [tracearrLink(n), variant.server(n), imdbLink(n)],
    };
  });
  const artists = Array.from({ length: sectionMax }, (_, i) => {
    const n = 300 + i;
    return {
      id: uuid(n),
      name: `Some Band Called ${i}`,
      posterRef: variant.poster(n + 50),
      albums: [
        { id: uuid(n + 50), title: 'Album Number 0 With A Long Name', year: 2010, trackCount: 12 },
      ],
      serverName: 'Basement Plex',
      links: [tracearrLink(n), variant.server(n)],
    };
  });
  const mostWatched = Array.from({ length: MOST_WATCHED_MAX }, (_, i) => {
    const n = 400 + i;
    return {
      id: uuid(n),
      kind: i % 2 ? ('show' as const) : ('movie' as const),
      title: `Watched Title ${i}`,
      year: 2020,
      plays: 40 - i,
      posterRef: variant.poster(n),
      serverName: 'Basement Plex',
      links: [tracearrLink(n), variant.server(n)],
    };
  });
  return base({
    ...copy,
    movies,
    shows,
    artists,
    mostWatched,
    logoRef: 'cid:logo',
    moreMovies: 4988,
    moreShows: 4988,
    moreAlbums: 4988,
    moreWatched: 0,
    episodes: 1320,
  });
}

describe('renderDigest', () => {
  it('renders every section, the window, the copy, and the links', async () => {
    const out = await renderDigest(
      base({
        movies: [
          {
            id: 'm1',
            title: 'Heat',
            year: 1995,
            posterRef: 'poster:m1',
            genres: ['Crime'],
            serverName: 'Basement Plex',
            links,
          },
        ],
        shows: [
          {
            id: 's1',
            title: 'The Wire',
            year: 2002,
            posterRef: 'poster:s1',
            seasons: [
              {
                number: 2,
                title: 'Season 2',
                episodeRange: 'E01-E04',
                episodeCount: 4,
                whole: false,
              },
            ],
            moreSeasons: 0,
            episodeCount: 4,
            serverName: 'Basement Plex',
            links,
          },
        ],
        artists: [
          {
            id: 'a1',
            name: 'Portishead',
            posterRef: null,
            albums: [{ id: 'al1', title: 'Dummy', year: 1994, trackCount: 11 }],
            serverName: 'Basement Plex',
            links: [],
          },
        ],
        mostWatched: [
          {
            id: 'w1',
            kind: 'movie',
            title: 'Alien',
            year: 1979,
            plays: 7,
            posterRef: null,
            serverName: 'Basement Plex',
            links: [{ label: 'IMDb', url: 'https://www.imdb.com/title/tt0078748/' }],
          },
        ],
      }),
      branding
    );
    expect(out.subject).toBe("What's new on Basement Plex (Sep 2, 2026)");
    expect(out.html).toContain('Aug 26, 2026');
    expect(out.html).toContain('Here is what landed this week.');
    expect(out.html).toContain('src="poster:m1"');
    expect(out.html).not.toContain('rel="preload"');
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

  it('renders the most watched row links', async () => {
    const out = await renderDigest(
      base({
        mostWatched: [
          {
            id: 'w1',
            kind: 'movie',
            title: 'Alien',
            year: 1979,
            plays: 7,
            posterRef: null,
            serverName: 'Basement Plex',
            links: [{ label: 'IMDb', url: 'https://www.imdb.com/title/tt0078748/' }],
          },
        ],
      }),
      branding
    );
    expect(out.html).toContain('href="https://www.imdb.com/title/tt0078748/"');
    expect(out.text).toContain('https://www.imdb.com/title/tt0078748/');
  });

  it('ranks the most watched rows inside one card, the play count after the title and a rule between rows', async () => {
    const row = (n: number, title: string, plays: number) => ({
      id: `w${n}`,
      kind: 'movie' as const,
      title,
      year: 2000 + n,
      plays,
      posterRef: n === 2 ? null : `poster:w${n}`,
      serverName: 'Basement Plex',
      links: [{ label: 'IMDb', url: `https://www.imdb.com/title/tt000000${n}/` }],
    });
    const out = await renderDigest(
      base({ mostWatched: [row(1, 'Alien', 9), row(2, 'Heat', 5), row(3, 'Seven', 1)] }),
      branding
    );
    expect(out.text).toContain('1 Alien (2001)');
    expect(out.text).toContain('9 plays · IMDb');
    expect(out.text).toContain('2 Heat (2002)');
    expect(out.text).toContain('3 Seven (2003)');
    expect(out.text).toContain('1 play · IMDb');
    expect(out.text.indexOf('1 Alien')).toBeLessThan(out.text.indexOf('2 Heat'));
    expect(out.text.indexOf('2 Heat')).toBeLessThan(out.text.indexOf('3 Seven'));
    expect(out.html).toContain(`<span style="color:${branding.accentColor}">1</span>`);
    // The one most-watched card: no row carries an outline of its own.
    expect(out.html.match(/border:1px solid #343945/g)).toHaveLength(1);
    expect(out.html.match(/width="44"/g)).toHaveLength(2);
  });

  it('emits each footer placeholder once, as the only anchor of its own paragraph', async () => {
    const out = await renderDigest(
      base({ unsubscribeUrl: '{{unsubscribe_url}}', viewUrl: '{{view_url}}' }),
      branding
    );
    expect(out.html.match(/\{\{view_url\}\}/g)).toHaveLength(1);
    expect(out.html.match(/\{\{unsubscribe_url\}\}/g)).toHaveLength(1);
    expect(out.html).toMatch(
      /<p[^>]*>\s*<a[^>]*href="\{\{view_url\}\}"[^>]*>View in browser<\/a>\s*<\/p>/
    );
    expect(out.html).toMatch(
      /<p[^>]*>\s*<a[^>]*href="\{\{unsubscribe_url\}\}"[^>]*>Unsubscribe<\/a>\s*<\/p>/
    );
    expect(out.text).toContain('{{view_url}}');
    expect(out.text).toContain('{{unsubscribe_url}}');
  });

  it('names the servers and the window in the empty state, falling back to the sender name', async () => {
    const out = await renderDigest(base(), branding);
    expect(out.text).toContain(
      'Nothing was added to Basement Plex between Aug 26, 2026 and Sep 2, 2026.'
    );
    expect(out.html).not.toContain('<img');
    const bare = await renderDigest(base({ serverNames: [] }), defaultBranding('Attic Media'));
    expect(bare.text).toContain('Nothing was added to Attic Media between');
  });

  it('puts the browser link first, then the logo and the sender name centered in the masthead', async () => {
    const out = await renderDigest(
      base({ viewUrl: '{{view_url}}', logoRef: 'cid:logo' }),
      branding
    );
    expect(out.html).toContain('<img alt="" height="48" src="cid:logo"');
    expect(out.html.indexOf('View in browser')).toBeLessThan(out.html.indexOf('src="cid:logo"'));
    expect(out.html.indexOf('src="cid:logo"')).toBeLessThan(out.html.indexOf('Basement Plex</p>'));
    expect(out.html).toMatch(/font-size:20px[^"]*">Basement Plex<\/p>/);
    expect(out.text.indexOf('View in browser')).toBeLessThan(out.text.indexOf('Basement Plex'));
    const noLogo = await renderDigest(base({ logoRef: null }), branding);
    expect(noLogo.html).not.toContain('<img');
    expect(noLogo.html).toMatch(/font-size:22px[^"]*">Basement Plex<\/p>/);
  });

  it('totals the window in the hero, counting what the caps hid and the episodes across every show', async () => {
    const out = await renderDigest(
      base({
        movies: [
          {
            id: 'm1',
            title: 'Heat',
            year: 1995,
            posterRef: null,
            genres: [],
            serverName: 'Basement Plex',
            links: [],
          },
        ],
        moreMovies: 1,
        shows: [
          {
            id: 's1',
            title: 'The Wire',
            year: 2002,
            posterRef: null,
            seasons: [],
            moreSeasons: 0,
            episodeCount: 4,
            serverName: 'Basement Plex',
            links: [],
          },
        ],
        episodes: 6,
        artists: [
          {
            id: 'a1',
            name: 'Portishead',
            posterRef: null,
            albums: [{ id: 'al1', title: 'Dummy', year: 1994, trackCount: 11 }],
            serverName: 'Basement Plex',
            links: [],
          },
        ],
        moreAlbums: 2,
      }),
      branding
    );
    expect(out.text).toContain('2 movies · 1 show · 6 episodes · 3 albums');
    expect(out.text.indexOf('Aug 26, 2026 to Sep 2, 2026')).toBeLessThan(
      out.text.indexOf('2 movies · 1 show')
    );
    const nothing = await renderDigest(base(), branding);
    expect(nothing.text).not.toContain('0 movies');
  });

  it('places the outro above the footer rule and the permission line above the unsubscribe line', async () => {
    const out = await renderDigest(base(), branding);
    expect(out.text.indexOf('Enjoy!')).toBeLessThan(out.text.indexOf('member of Basement Plex'));
    expect(out.text.indexOf('member of Basement Plex')).toBeLessThan(
      out.text.indexOf('{{unsubscribe_url}}')
    );
    expect(out.text.indexOf('{{unsubscribe_url}}')).toBeLessThan(
      out.text.indexOf('Sent by Tracearr for Basement Plex.')
    );
  });

  it('says to reply when there is no unsubscribe link and omits a null view link', async () => {
    const out = await renderDigest(base({ unsubscribeUrl: null }), branding);
    expect(out.html).toContain('Reply to this email to unsubscribe');
    expect(out.html).not.toContain('{{unsubscribe_url}}');
    expect(out.html).not.toContain('View in browser');
  });

  it('escapes owner text', async () => {
    const out = await renderDigest(base({ intro: paragraphDoc('<script>x</script>') }), branding);
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
            seasons: [
              {
                number: 1,
                title: 'Season 1',
                episodeRange: 'E01-E03',
                episodeCount: 3,
                whole: false,
              },
            ],
            moreSeasons: 2,
            episodeCount: 3,
            serverName: 'Basement Plex',
            links: [],
          },
        ],
      }),
      branding
    );
    expect(out.html).toContain('+2 more seasons');
  });

  it('says a whole season came in full and keeps the range for a partial one', async () => {
    const out = await renderDigest(
      base({
        shows: [
          {
            id: 's3',
            title: 'Chernobyl',
            year: 2019,
            posterRef: null,
            seasons: [
              { number: 1, title: 'Season 1', episodeRange: '', episodeCount: 0, whole: true },
              { number: 2, title: 'Season 2', episodeRange: '', episodeCount: 12, whole: true },
              {
                number: 3,
                title: 'Season 3',
                episodeRange: 'E01-E03',
                episodeCount: 3,
                whole: false,
              },
            ],
            moreSeasons: 0,
            episodeCount: 15,
            serverName: 'Basement Plex',
            links: [],
          },
        ],
      }),
      branding
    );
    // A season-level add event carries no episode count; an episode-by-episode one does.
    expect(out.text).toContain('Season 1, all episodes');
    expect(out.text).toContain('Season 2, all 12 episodes');
    expect(out.text).toContain('Season 3 · E01-E03 (3 episodes)');
    expect(out.text).not.toContain('(0 episodes)');
  });

  it('lists up to three genres under a movie and names the server only on a multi-server digest', async () => {
    const movie = {
      id: 'm1',
      title: 'Heat',
      year: 1995,
      posterRef: null,
      genres: ['Crime', 'Drama', 'Thriller', 'Action'],
      serverName: 'Basement Plex',
      links: [],
    };
    const alien = {
      id: 'w1',
      kind: 'movie' as const,
      title: 'Alien',
      year: 1979,
      plays: 7,
      posterRef: null,
      serverName: 'Attic',
      links: [],
    };
    const single = await renderDigest(base({ movies: [movie], mostWatched: [alien] }), branding);
    expect(single.text).toContain('Crime · Drama · Thriller');
    expect(single.text).not.toContain('Action');
    expect(single.text).not.toContain('Basement Plex · Crime');
    expect(single.text).toContain('1 Alien (1979)');
    expect(single.text).toContain('7 plays');
    expect(single.text).not.toContain('Attic');

    const multi = await renderDigest(
      base({
        multiServer: true,
        serverNames: ['Attic', 'Basement Plex'],
        movies: [movie],
        mostWatched: [alien],
      }),
      branding
    );
    expect(multi.text).toContain('Basement Plex · Crime · Drama · Thriller');
    expect(multi.text).toContain('1 Alien (1979)');
    expect(multi.text).toContain('7 plays · Attic');
  });

  it('previews what was added instead of repeating the subject, and falls back to the subject with nothing added', async () => {
    const out = await renderDigest(
      base({
        movies: [
          {
            id: 'm1',
            title: 'Heat',
            year: 1995,
            posterRef: null,
            genres: [],
            serverName: 'Basement Plex',
            links: [],
          },
        ],
        moreMovies: 11,
        shows: [
          {
            id: 's1',
            title: 'The Wire',
            year: 2002,
            posterRef: null,
            seasons: [],
            moreSeasons: 0,
            episodeCount: 0,
            serverName: 'Basement Plex',
            links: [],
          },
        ],
        artists: [
          {
            id: 'a1',
            name: 'Portishead',
            posterRef: null,
            albums: [{ id: 'al1', title: 'Dummy', year: 1994, trackCount: 11 }],
            serverName: 'Basement Plex',
            links: [],
          },
        ],
        moreAlbums: 2,
      }),
      branding
    );
    expect(out.html).toContain(
      '12 movies, 1 show and 3 albums added between Aug 26, 2026 and Sep 2, 2026'
    );
    const watchedOnly = await renderDigest(
      base({
        mostWatched: [
          {
            id: 'w1',
            kind: 'movie',
            title: 'Alien',
            year: 1979,
            plays: 7,
            posterRef: null,
            serverName: 'Basement Plex',
            links: [],
          },
        ],
      }),
      branding
    );
    expect(watchedOnly.html).not.toContain('added between');
  });

  it('tells the member why they got it, above the unsubscribe line, listing every scoped server', async () => {
    const three = await renderDigest(
      base({ serverNames: ['Attic', 'Basement Plex', 'Shed'] }),
      branding
    );
    expect(three.text).toContain(
      'You get this because you are a member of Attic, Basement Plex and Shed.'
    );
    const one = await renderDigest(base(), branding);
    expect(one.text).toContain('You get this because you are a member of Basement Plex.');
    expect(one.text.indexOf('member of Basement Plex')).toBeLessThan(
      one.text.indexOf('{{unsubscribe_url}}')
    );
  });

  it('drops the member reminder on a test send even with servers scoped', async () => {
    const out = await renderDigest(base({ memberSend: false }), branding);
    expect(out.text).not.toContain('member of');
  });

  it('renders the album cover on an artist card and the poster on a most watched row', async () => {
    const out = await renderDigest(
      base({
        artists: [
          {
            id: 'a1',
            name: 'Portishead',
            posterRef: 'poster:al1',
            albums: [{ id: 'al1', title: 'Dummy', year: 1994, trackCount: 11 }],
            serverName: 'Basement Plex',
            links: [],
          },
        ],
        mostWatched: [
          {
            id: 'w1',
            kind: 'movie',
            title: 'Alien',
            year: 1979,
            plays: 7,
            posterRef: 'poster:w1',
            serverName: 'Basement Plex',
            links: [],
          },
        ],
      }),
      branding
    );
    expect(out.html).toContain('src="poster:al1"');
    expect(out.html).toContain('alt="Portishead"');
    expect(out.html).toContain('src="poster:w1"');
    expect(out.html).toContain('alt="Alien"');
    expect(out.html).toContain('<img alt="Portishead" height="150" src="poster:al1"');
    expect(out.html).toContain('<img alt="Alien" height="66" src="poster:w1"');
    expect(out.html.match(/width="100"/g)).toHaveLength(1);
    expect(out.html.match(/width="44"/g)).toHaveLength(1);
  });

  it('renders an artist card with no warmed cover without an image', async () => {
    const out = await renderDigest(
      base({
        artists: [
          {
            id: 'a1',
            name: 'Portishead',
            posterRef: null,
            albums: [{ id: 'al1', title: 'Dummy', year: 1994, trackCount: 11 }],
            serverName: 'Basement Plex',
            links: [],
          },
        ],
      }),
      branding
    );
    expect(out.html).not.toContain('<img');
  });

  it('heads each section with its window total', async () => {
    const out = await renderDigest(
      base({
        movies: [
          {
            id: 'm1',
            title: 'Heat',
            year: 1995,
            posterRef: null,
            genres: [],
            serverName: 'Basement Plex',
            links: [],
          },
        ],
        moreMovies: 11,
        shows: [
          {
            id: 's1',
            title: 'The Wire',
            year: 2002,
            posterRef: null,
            seasons: [],
            moreSeasons: 0,
            episodeCount: 0,
            serverName: 'Basement Plex',
            links: [],
          },
        ],
        artists: [
          {
            id: 'a1',
            name: 'Portishead',
            posterRef: null,
            albums: [
              { id: 'al1', title: 'Dummy', year: 1994, trackCount: 11 },
              { id: 'al2', title: 'Third', year: 2008, trackCount: 11 },
            ],
            serverName: 'Basement Plex',
            links: [],
          },
        ],
        moreAlbums: 1,
        mostWatched: [
          {
            id: 'w1',
            kind: 'movie',
            title: 'Alien',
            year: 1979,
            plays: 7,
            posterRef: null,
            serverName: 'Basement Plex',
            links: [],
          },
        ],
        moreWatched: 4,
      }),
      branding
    );
    expect(out.html).toMatch(/<h2[^>]*>Movies<\/h2>/);
    expect(out.html).toContain('>12 new</p>');
    expect(out.html).toMatch(/<h2[^>]*>TV<\/h2>/);
    expect(out.html).toContain('>1 new</p>');
    expect(out.html).toMatch(/<h2[^>]*>Music<\/h2>/);
    expect(out.html).toContain('>3 new</p>');
    expect(out.html).toMatch(/<h2[^>]*>Most watched<\/h2>/);
    expect(out.html).toContain('>top 1</p>');
    expect(out.html).toContain('+11 more movies');
    expect(out.html).toContain('+1 more album');
    expect(out.html).toContain('+4 more titles');
  });

  it('sets the year beside the title in the muted tone and keeps the plain text as title (year)', async () => {
    const out = await renderDigest(
      base({
        movies: [
          {
            id: 'm1',
            title: 'Heat',
            year: 1995,
            posterRef: 'poster:m1',
            genres: ['Crime'],
            serverName: 'Basement Plex',
            links,
          },
        ],
      }),
      branding
    );
    expect(out.html).toMatch(/Heat<span style="color:#9aa3ad;font-weight:400"> \(1995\)<\/span>/);
    expect(out.text).toContain('Heat (1995)');
    expect(out.html).toContain('<img alt="Heat" height="150" src="poster:m1"');
    expect(out.html).toContain('width:112px');
  });

  it('spreads a card without a poster across the full width instead of leaving an empty gutter', async () => {
    const out = await renderDigest(
      base({
        movies: [
          {
            id: 'm1',
            title: 'Heat',
            year: null,
            posterRef: null,
            genres: [],
            serverName: 'Basement Plex',
            links: [],
          },
        ],
      }),
      branding
    );
    expect(out.html).not.toContain('<img');
    expect(out.html).not.toContain('width:112px');
    expect(out.text).toContain('Heat');
    expect(out.text).not.toContain('Heat (');
  });

  it('counts the new episodes on the show meta line and groups the seasons in one box', async () => {
    const out = await renderDigest(
      base({
        shows: [
          {
            id: 's1',
            title: 'The Wire',
            year: 2002,
            posterRef: null,
            seasons: [
              { number: 1, title: 'Season 1', episodeRange: '', episodeCount: 13, whole: true },
              {
                number: 2,
                title: 'Season 2',
                episodeRange: 'E01-E06',
                episodeCount: 6,
                whole: false,
              },
            ],
            moreSeasons: 0,
            episodeCount: 19,
            serverName: 'Basement Plex',
            links: [],
          },
        ],
      }),
      branding
    );
    expect(out.text).toContain('19 new episodes');
    expect(out.text.indexOf('19 new episodes')).toBeLessThan(out.text.indexOf('Season 1'));
    expect(out.html.match(/background-color:#23272f/g)).toHaveLength(1);
    expect(out.text).toContain('Season 1, all 13 episodes');
    expect(out.text).toContain('Season 2 · E01-E06 (6 episodes)');
    const one = await renderDigest(
      base({
        shows: [
          {
            id: 's2',
            title: 'Andor',
            year: 2022,
            posterRef: null,
            seasons: [
              { number: 2, title: 'Season 2', episodeRange: 'E07', episodeCount: 1, whole: false },
            ],
            moreSeasons: 0,
            episodeCount: 1,
            serverName: 'Basement Plex',
            links: [],
          },
        ],
      }),
      branding
    );
    expect(one.text).toContain('1 new episode');
    expect(one.text).not.toContain('1 new episodes');
  });

  it('leaves the season box out when a show arrives with no seasons', async () => {
    const out = await renderDigest(
      base({
        shows: [
          {
            id: 's3',
            title: 'Andor',
            year: 2022,
            posterRef: null,
            seasons: [],
            moreSeasons: 0,
            episodeCount: 0,
            serverName: 'Basement Plex',
            links: [],
          },
        ],
      }),
      branding
    );
    expect(out.text).toContain('Andor (2022)');
    expect(out.html).not.toContain('background-color:#23272f');
  });

  it('writes each album as title, year and track count on its own line', async () => {
    const out = await renderDigest(
      base({
        artists: [
          {
            id: 'a1',
            name: 'Portishead',
            posterRef: null,
            albums: [
              { id: 'al1', title: 'Dummy', year: 1994, trackCount: 11 },
              { id: 'al2', title: 'Roseland NYC Live', year: null, trackCount: 1 },
            ],
            serverName: 'Basement Plex',
            links: [],
          },
        ],
      }),
      branding
    );
    expect(out.text).toContain('Dummy (1994) · 11 tracks');
    expect(out.text).toContain('Roseland NYC Live · 1 track');
  });

  const COPY = {
    'nineteen linked runs in both fields': { intro: heaviestRuns, outro: heaviestRuns },
    'eight linked list items in both fields': { intro: heaviestList, outro: heaviestList },
  };

  // The clip ceiling is asserted by apps/server/src/services/newsletters/__tests__/fit.test.ts
  // against what delivery substitutes; this block only records that each variant renders.
  it.each(
    Object.entries(VARIANTS).flatMap(([name, variant]) =>
      Object.entries(COPY).map(
        ([copyName, copy]) => [`${name}, ${copyName}`, variant, copy] as const
      )
    )
  )('renders every section at its cap with %s', async (_name, variant, copy) => {
    const out = await renderDigest(maxInput(variant, copy), branding);
    expect(Buffer.byteLength(out.html, 'utf8')).toBeGreaterThan(0);
  });

  /** Measured 2026-09-10 on maxInput with hosted jellyfin poster urls and nineteen linked runs in both copy fields: the whole document 114,654 B; a movie card 1,903 B, a show card 3,336 B, an artist card 1,679 B, a most-watched row 1,659 B. The ceilings sit about 4% above, so a regression the size of the margin shorthand (11 KB across the digest) or a button per card (300 B) fails here before the fit loop pays for it in titles. */
  const HEAVIEST_CEILING = 119_000;
  const CARD_CEILINGS = {
    movies: 1_980,
    shows: 3_470,
    artists: 1_750,
    mostWatched: 1_730,
  } as const;

  it('keeps the heaviest digest and each card kind under the byte ceilings without doubling any margin into longhands', async () => {
    const full = maxInput(
      VARIANTS['hosted urls over jellyfin image paths']!,
      COPY['nineteen linked runs in both fields']
    );
    const bytes = async (input: DigestInput) =>
      Buffer.byteLength((await renderDigest(input, branding)).html, 'utf8');
    const whole = await bytes(full);
    expect(whole).toBeLessThanOrEqual(HEAVIEST_CEILING);
    expect(
      whole - (await bytes({ ...full, movies: full.movies.slice(0, -1) }))
    ).toBeLessThanOrEqual(CARD_CEILINGS.movies);
    expect(whole - (await bytes({ ...full, shows: full.shows.slice(0, -1) }))).toBeLessThanOrEqual(
      CARD_CEILINGS.shows
    );
    expect(
      whole - (await bytes({ ...full, artists: full.artists.slice(0, -1) }))
    ).toBeLessThanOrEqual(CARD_CEILINGS.artists);
    expect(
      whole - (await bytes({ ...full, mostWatched: full.mostWatched.slice(0, -1) }))
    ).toBeLessThanOrEqual(CARD_CEILINGS.mostWatched);
    const { html } = await renderDigest(full, branding);
    expect(html).not.toMatch(/;margin:[^;"]*;margin-top:/);
  });

  it('gives every image width, height and alt so a blocked-images client keeps the layout', async () => {
    const out = await renderDigest(
      maxInput(VARIANTS['inline cid references']!, COPY['nineteen linked runs in both fields']),
      branding
    );
    const imgs = out.html.match(/<img[^>]*>/g) ?? [];
    expect(imgs).toHaveLength(47);
    for (const img of imgs) {
      expect(img).toMatch(/\balt="/);
      expect(img).toMatch(/\bwidth="\d+"/);
      expect(img).toMatch(/\bheight="\d+"/);
    }
  });

  it('says how many items each section holds beyond its cards, singular when one', async () => {
    const out = await renderDigest(
      base({
        movies: [
          {
            id: 'm1',
            title: 'Heat',
            year: 1995,
            posterRef: null,
            genres: [],
            serverName: 'Basement Plex',
            links: [],
          },
        ],
        artists: [
          {
            id: 'a1',
            name: 'Portishead',
            posterRef: null,
            albums: [],
            serverName: 'Basement Plex',
            links: [],
          },
        ],
        mostWatched: [
          {
            id: 'w1',
            kind: 'movie',
            title: 'Alien',
            year: 1979,
            plays: 7,
            posterRef: null,
            serverName: 'Basement Plex',
            links: [],
          },
        ],
        moreMovies: 18,
        moreShows: 4,
        moreAlbums: 1,
        moreWatched: 2,
      }),
      branding
    );
    expect(out.html).toContain('+18 more movies');
    expect(out.html).not.toContain('more shows');
    expect(out.html).toContain('+1 more album');
    expect(out.html).toContain('+2 more titles');
    expect(out.text).toContain('+18 more movies');
  });

  it('gives every emitted table cell an explicit background and text color', async () => {
    const out = await renderDigest(
      maxInput(
        VARIANTS['hosted urls over plex thumb paths']!,
        COPY['nineteen linked runs in both fields']
      ),
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
