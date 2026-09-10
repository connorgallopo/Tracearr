import { describe, expect, it } from 'vitest';
import { sectionItemCounts, type DigestData } from '../assemble.js';
import {
  LOGO_ROUTE,
  VIEW_PLACEHOLDER,
  buildDigestInput,
  digestLinks,
  formatWindowDate,
  logoRefFor,
  resolveImageMode,
  substitutePosterRefs,
} from '../render.js';
import type { ServerLink } from '../store.js';

const posters = {
  m1: {
    serverId: '11111111-1111-4111-8111-111111111111',
    thumbPath: '/library/metadata/1/thumb',
    version: 'abcdef12',
  },
};
const html = '<p>x</p><img src="poster:m1" alt="Heat" width="80"><img src="cid:logo" alt="logo">';

describe('substitutePosterRefs', () => {
  it('hosted mode points at the external url with the versioned proxy path', () => {
    const out = substitutePosterRefs(html, posters, 'hosted', 'https://tracearr.example.com/');
    expect(out).toContain(
      'src="https://tracearr.example.com/api/v1/images/proxy?server=11111111-1111-4111-8111-111111111111&url=%2Flibrary%2Fmetadata%2F1%2Fthumb&width=360&height=540&fallback=poster&v=abcdef12"'
    );
    expect(out).toContain('src="cid:logo"');
  });
  it('inline mode rewrites to a cid and leaves unknown refs as no image', () => {
    const out = substitutePosterRefs(
      `${html}<img src="poster:unknown" alt="x">`,
      posters,
      'inline',
      null
    );
    expect(out).toContain('src="cid:m1"');
    expect(out).not.toContain('poster:unknown');
    expect(out).not.toContain('alt="x"');
  });
  it('none mode removes poster images and keeps the logo', () => {
    const out = substitutePosterRefs(html, posters, 'none', null);
    expect(out).not.toContain('<img src="poster:');
    expect(out).not.toContain('alt="Heat"');
    expect(out).toContain('src="cid:logo"');
  });
});

describe('resolveImageMode', () => {
  it('auto and hosted-without-url resolve to inline; hosted needs a url; none stays none', () => {
    expect(resolveImageMode('auto', 'https://x')).toBe('inline');
    expect(resolveImageMode('auto', null)).toBe('inline');
    expect(resolveImageMode('hosted', null)).toBe('inline');
    expect(resolveImageMode('hosted', 'https://x')).toBe('hosted');
    expect(resolveImageMode('inline', 'https://x')).toBe('inline');
    expect(resolveImageMode('none', 'https://x')).toBe('none');
  });
});

describe('logoRefFor', () => {
  const tracearr = { mode: 'tracearr' as const };
  const url = { mode: 'url' as const, url: 'https://x.test/logo.png' };
  const none = { mode: 'none' as const };

  it('attaches inline, links hosted, and drops the logo without images', () => {
    expect(logoRefFor(tracearr, 'inline', '', true)).toBe('cid:logo');
    expect(logoRefFor(tracearr, 'hosted', 'https://x.test', true)).toBe(
      'https://x.test/api/v1/images/logo'
    );
    expect(logoRefFor(tracearr, 'hosted', '', true)).toBe(LOGO_ROUTE);
    expect(logoRefFor(tracearr, 'none', 'https://x.test', true)).toBeNull();
  });

  it('needs a png for the tracearr logo', () => {
    expect(logoRefFor(tracearr, 'inline', '', false)).toBeNull();
    expect(logoRefFor(tracearr, 'hosted', 'https://x.test', false)).toBeNull();
  });

  it('uses the owner url in every mode but none, and none never renders one', () => {
    expect(logoRefFor(url, 'inline', '', false)).toBe('https://x.test/logo.png');
    expect(logoRefFor(url, 'hosted', 'https://x.test', false)).toBe('https://x.test/logo.png');
    expect(logoRefFor(url, 'none', '', true)).toBeNull();
    expect(logoRefFor(none, 'inline', '', true)).toBeNull();
    expect(logoRefFor(none, 'hosted', 'https://x.test', true)).toBeNull();
  });
});

describe('buildDigestInput', () => {
  const watched = {
    cardId: 'w1',
    serverId: 's1',
    serverName: 'Basement',
    serverType: 'plex',
    ratingKey: '77',
    mediaId: 'media-9',
    imdbId: 'tt0468569',
    thumbPath: null,
    mirrors: [],
    kind: 'movie' as const,
    title: 'The Dark Knight',
    year: 2008,
    plays: 12,
  };

  it('carries the exact Tracearr, media server and IMDb link strings for a movie card', () => {
    const data: DigestData = {
      movies: [
        {
          cardId: 'm1',
          serverId: 's1',
          serverName: 'Basement',
          serverType: 'plex',
          ratingKey: '42',
          mediaId: 'media-1',
          imdbId: 'tt0113277',
          thumbPath: '/t',
          mirrors: [],
          title: 'Heat',
          year: 1995,
          genres: ['Crime', 'Drama'],
          addedAt: new Date(),
        },
      ],
      shows: [],
      artists: [],
      mostWatched: [watched],
      counts: { movies: 1, shows: 0, episodes: 0, albums: 0, mostWatched: 1 },
      isEmpty: false,
    };
    const serversById = new Map<string, ServerLink>([
      [
        's1',
        {
          id: 's1',
          name: 'Basement',
          type: 'plex',
          url: 'http://plex.local',
          machineIdentifier: 'mach-1',
          publicUrl: null,
        },
      ],
    ]);
    const input = buildDigestInput(
      data,
      {},
      {
        subject: 'x',
        intro: null,
        outro: null,
        windowStart: 'Aug 1, 2026',
        windowEnd: 'Aug 8, 2026',
        logoRef: null,
        unsubscribeUrl: null,
        viewUrl: VIEW_PLACEHOLDER,
        externalUrl: 'https://tracearr.example.com',
        tracearrLinks: true,
        serversById,
        memberSend: true,
      }
    );
    expect(input.movies[0]?.links).toEqual([
      { label: 'Tracearr', url: 'https://tracearr.example.com/media/media-1' },
      {
        label: 'Basement',
        url: 'https://app.plex.tv/desktop/#!/server/mach-1/details?key=%2Flibrary%2Fmetadata%2F42',
      },
      { label: 'IMDb', url: 'https://www.imdb.com/title/tt0113277/' },
    ]);
    expect(input.viewUrl).toBe('{{view_url}}');
    expect(input.multiServer).toBe(false);
    expect(input.memberSend).toBe(true);
    expect(input.serverNames).toEqual(['Basement']);
    expect(input.movies[0]?.serverName).toBe('Basement');
    expect(input.movies[0]?.genres).toEqual(['Crime', 'Drama']);
    expect(input.mostWatched[0]?.serverName).toBe('Basement');

    const withoutImdb = digestLinks(watched, 'https://tracearr.example.com', serversById, {
      tracearr: true,
      imdb: false,
    });
    expect(withoutImdb).toEqual([
      { label: 'Tracearr', url: 'https://tracearr.example.com/media/media-9' },
      {
        label: 'Basement',
        url: 'https://app.plex.tv/desktop/#!/server/mach-1/details?key=%2Flibrary%2Fmetadata%2F77',
      },
    ]);
    expect(
      digestLinks(watched, 'https://tracearr.example.com', serversById, { tracearr: true })
    ).toHaveLength(3);
    expect(input.mostWatched[0]?.links).toEqual(withoutImdb);
  });

  it('marks the digest multi-server from the resolved scope and lists the names in order', () => {
    const two = new Map<string, ServerLink>([
      [
        'a',
        {
          id: 'a',
          name: 'Attic',
          type: 'jellyfin',
          url: 'https://jf.example.com',
          machineIdentifier: null,
          publicUrl: null,
        },
      ],
      [
        'b',
        {
          id: 'b',
          name: 'Basement',
          type: 'plex',
          url: 'http://plex',
          machineIdentifier: 'm',
          publicUrl: null,
        },
      ],
    ]);
    const data: DigestData = {
      movies: [],
      shows: [
        {
          cardId: 's1',
          serverId: 'a',
          serverName: 'Attic',
          serverType: 'jellyfin',
          ratingKey: '5',
          mediaId: null,
          imdbId: null,
          thumbPath: null,
          mirrors: [],
          title: 'Chernobyl',
          year: 2019,
          seasons: [
            { number: 1, title: 'Season 1', episodeRange: '', episodeCount: 0, whole: true },
          ],
          moreSeasons: 0,
          episodeCount: 0,
          addedAt: new Date(),
        },
      ],
      artists: [],
      mostWatched: [],
      counts: { movies: 0, shows: 1, episodes: 0, albums: 0, mostWatched: 0 },
      isEmpty: false,
    };
    const input = buildDigestInput(
      data,
      {},
      {
        subject: 'x',
        intro: null,
        outro: null,
        windowStart: 'Aug 1, 2026',
        windowEnd: 'Aug 8, 2026',
        logoRef: null,
        unsubscribeUrl: null,
        viewUrl: null,
        externalUrl: null,
        tracearrLinks: false,
        serversById: two,
        memberSend: false,
      }
    );
    expect(input.multiServer).toBe(true);
    expect(input.memberSend).toBe(false);
    expect(input.serverNames).toEqual(['Attic', 'Basement']);
    expect(input.shows[0]?.serverName).toBe('Attic');
    expect(input.shows[0]?.seasons[0]?.whole).toBe(true);
  });

  it('emits the Tracearr link only when the newsletter turns it on', () => {
    const serversById = new Map<string, ServerLink>([
      [
        's1',
        {
          id: 's1',
          name: 'Basement',
          type: 'plex',
          url: 'http://plex',
          machineIdentifier: 'abc',
          publicUrl: null,
        },
      ],
    ]);
    const off = digestLinks(watched, 'https://tracearr.example.com', serversById, {
      tracearr: false,
    });
    expect(off.map((l) => l.label)).toEqual(['Basement', 'IMDb']);
    const on = digestLinks(watched, 'https://tracearr.example.com', serversById, {
      tracearr: true,
    });
    expect(on[0]).toEqual({ label: 'Tracearr', url: 'https://tracearr.example.com/media/media-9' });
    const noUrl = digestLinks(watched, null, serversById, { tracearr: true });
    expect(noUrl.map((l) => l.label)).toEqual(['Basement', 'IMDb']);
  });

  it('drops the Jellyfin and Emby item link when the server url is private and keeps Plex through app.plex.tv', () => {
    const lan = new Map<string, ServerLink>([
      [
        'j',
        {
          id: 'j',
          name: 'Attic',
          type: 'jellyfin',
          url: 'http://192.168.1.20:8096',
          machineIdentifier: null,
          publicUrl: null,
        },
      ],
      [
        'e',
        {
          id: 'e',
          name: 'Shed',
          type: 'emby',
          url: 'http://emby.local:8096',
          machineIdentifier: 'emb-1',
          publicUrl: null,
        },
      ],
      [
        'p',
        {
          id: 'p',
          name: 'Basement',
          type: 'plex',
          url: 'http://192.168.1.10:32400',
          machineIdentifier: 'mach-1',
          publicUrl: null,
        },
      ],
    ]);
    const on = (serverId: string) =>
      digestLinks({ ...watched, serverId, imdbId: null }, null, lan, { tracearr: false });
    expect(on('j')).toEqual([]);
    expect(on('e')).toEqual([]);
    expect(on('p')).toEqual([
      {
        label: 'Basement',
        url: 'https://app.plex.tv/desktop/#!/server/mach-1/details?key=%2Flibrary%2Fmetadata%2F77',
      },
    ]);
    const publicJellyfin = new Map<string, ServerLink>([
      [
        'j',
        {
          id: 'j',
          name: 'Attic',
          type: 'jellyfin',
          url: 'https://jellyfin.example.com',
          machineIdentifier: null,
          publicUrl: null,
        },
      ],
    ]);
    expect(
      digestLinks({ ...watched, serverId: 'j', imdbId: null }, null, publicJellyfin, {
        tracearr: false,
      })
    ).toEqual([
      { label: 'Attic', url: 'https://jellyfin.example.com/web/index.html#/details?id=77' },
    ]);
  });

  it('builds the Jellyfin and Emby link from the public address first, then a public server url, else nothing', () => {
    const link = (over: Partial<ServerLink>) =>
      digestLinks(
        { ...watched, serverId: 'j', imdbId: null },
        null,
        new Map<string, ServerLink>([
          [
            'j',
            {
              id: 'j',
              name: 'Attic',
              type: 'jellyfin',
              url: 'http://192.168.1.20:8096',
              publicUrl: null,
              machineIdentifier: null,
              ...over,
            },
          ],
        ]),
        { tracearr: false }
      );
    expect(link({ publicUrl: 'https://jellyfin.example.com' })).toEqual([
      { label: 'Attic', url: 'https://jellyfin.example.com/web/index.html#/details?id=77' },
    ]);
    expect(
      link({ url: 'https://lan-name.example.com', publicUrl: 'https://members.example.com/' })
    ).toEqual([
      { label: 'Attic', url: 'https://members.example.com/web/index.html#/details?id=77' },
    ]);
    expect(link({ url: 'https://lan-name.example.com' })).toEqual([
      { label: 'Attic', url: 'https://lan-name.example.com/web/index.html#/details?id=77' },
    ]);
    expect(
      link({ url: 'https://lan-name.example.com', publicUrl: 'http://10.0.0.5:8096' })
    ).toEqual([]);
    expect(
      link({ type: 'emby', machineIdentifier: 'emb-1', publicUrl: 'https://emby.example.com' })
    ).toEqual([
      {
        label: 'Attic',
        url: 'https://emby.example.com/web/index.html#!/item?id=77&serverId=emb-1',
      },
    ]);
  });

  it('reports what each section holds beyond its cards from the assembler counts', () => {
    const album = {
      cardId: 'al1',
      serverId: 's1',
      serverName: 'Basement',
      serverType: 'plex',
      ratingKey: '10',
      mediaId: null,
      imdbId: null,
      thumbPath: '/dummy',
      mirrors: [],
      title: 'Dummy',
      year: 1994,
      trackCount: 11,
    };
    const data: DigestData = {
      movies: [],
      shows: [],
      artists: [
        {
          cardId: 'a1',
          serverId: 's1',
          serverName: 'Basement',
          serverType: 'plex',
          ratingKey: '9',
          mediaId: null,
          imdbId: null,
          thumbPath: null,
          mirrors: [],
          name: 'Portishead',
          albums: [album, { ...album, cardId: 'al2', title: 'Third' }],
        },
      ],
      mostWatched: [watched],
      counts: { movies: 3, shows: 0, episodes: 7, albums: 5, mostWatched: 1 },
      isEmpty: false,
    };
    expect(sectionItemCounts(data)).toEqual({ movies: 0, shows: 0, albums: 2, mostWatched: 1 });
    const input = buildDigestInput(
      data,
      {
        al1: { serverId: 's1', thumbPath: '/dummy', version: 'v' },
        w1: { serverId: 's1', thumbPath: '/alien', version: 'v' },
      },
      {
        subject: 'x',
        intro: null,
        outro: null,
        windowStart: 'Aug 1, 2026',
        windowEnd: 'Aug 8, 2026',
        logoRef: null,
        unsubscribeUrl: null,
        viewUrl: null,
        externalUrl: null,
        tracearrLinks: false,
        serversById: new Map(),
        memberSend: true,
      }
    );
    expect(input.moreMovies).toBe(3);
    expect(input.moreShows).toBe(0);
    expect(input.moreAlbums).toBe(3);
    expect(input.moreWatched).toBe(0);
    expect(input.episodes).toBe(7);
    expect(input.artists[0]?.posterRef).toBe('poster:al1');
    expect(input.mostWatched[0]?.posterRef).toBe('poster:w1');
  });

  it('links every server a collapsed card exists on and names them all on the meta line', () => {
    const serversById = new Map<string, ServerLink>([
      [
        's1',
        {
          id: 's1',
          name: 'Basement',
          type: 'plex',
          url: 'http://plex.local',
          machineIdentifier: 'mach-1',
          publicUrl: null,
        },
      ],
      [
        's2',
        {
          id: 's2',
          name: 'Attic',
          type: 'jellyfin',
          url: 'http://10.0.0.5:8096',
          machineIdentifier: null,
          publicUrl: 'https://jellyfin.example.com',
        },
      ],
    ]);
    const data: DigestData = {
      movies: [
        {
          cardId: 'm1',
          serverId: 's1',
          serverName: 'Basement',
          serverType: 'plex',
          ratingKey: '42',
          mediaId: 'media-1',
          imdbId: null,
          thumbPath: null,
          mirrors: [{ serverId: 's2', ratingKey: 'abc123' }],
          title: 'Heat',
          year: 1995,
          genres: [],
          addedAt: new Date(),
        },
      ],
      shows: [],
      artists: [],
      mostWatched: [],
      counts: { movies: 1, shows: 0, episodes: 0, albums: 0, mostWatched: 0 },
      isEmpty: false,
    };
    const input = buildDigestInput(
      data,
      {},
      {
        subject: 'x',
        intro: null,
        outro: null,
        windowStart: 'Aug 1, 2026',
        windowEnd: 'Aug 8, 2026',
        logoRef: null,
        unsubscribeUrl: null,
        viewUrl: null,
        externalUrl: null,
        tracearrLinks: false,
        serversById,
        memberSend: true,
      }
    );
    expect(input.movies[0]?.links).toEqual([
      {
        label: 'Basement',
        url: 'https://app.plex.tv/desktop/#!/server/mach-1/details?key=%2Flibrary%2Fmetadata%2F42',
      },
      { label: 'Attic', url: 'https://jellyfin.example.com/web/index.html#/details?id=abc123' },
    ]);
    expect(input.movies[0]?.serverName).toBe('Basement, Attic');
  });
});

describe('formatWindowDate', () => {
  it('renders in the newsletter timezone', () => {
    expect(formatWindowDate(new Date('2026-09-02T03:00:00.000Z'), 'America/Los_Angeles')).toBe(
      'Sep 1, 2026'
    );
    expect(formatWindowDate(new Date('2026-09-02T03:00:00.000Z'), 'UTC')).toBe('Sep 2, 2026');
  });
});
