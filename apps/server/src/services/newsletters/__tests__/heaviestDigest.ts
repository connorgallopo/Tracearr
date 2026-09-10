import type { EmailRichTextDoc } from '@tracearr/shared';
import type { PosterRef } from '../../../db/schema.js';
import { posterVersionFor } from '../../imageProxy.js';
import type { DigestCard, DigestData } from '../assemble.js';
import type { ServerLink } from '../store.js';

/** 40 characters, the external URL length the emails size fixtures assume. */
export const EXTERNAL_URL = 'https://newsletters.mydomain-example.com';

export const JELLYFIN_SERVER: ServerLink = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Basement Jellyfin',
  type: 'jellyfin',
  url: 'https://jellyfin.mydomain-example.com',
  publicUrl: null,
  machineIdentifier: null,
};

const RICH_HREF = `https://example.com/${'x'.repeat(20)}`;

/** Nineteen one-character bold italic linked runs, weight 3,406: the heaviest paragraph the grammar admits. */
export function heaviestRuns(): EmailRichTextDoc {
  return {
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
}

/** Eight bold linked list items of 100 characters, weight 3,332. */
export function heaviestList(): EmailRichTextDoc {
  return {
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
}

const hex = (n: number, length: number): string =>
  n.toString(16).padStart(2, '0').repeat(length).slice(0, length);
const uuid = (n: number): string =>
  `${hex(n, 8)}-${hex(n, 4)}-4${hex(n, 3)}-8${hex(n, 3)}-${hex(n, 12)}`;
const jellyfinThumb = (n: number): string =>
  `Items/${hex(n, 32)}/Images/Primary?tag=${hex(n + 128, 32)}`;

function card(n: number, thumb: boolean): DigestCard {
  return {
    cardId: uuid(n),
    serverId: JELLYFIN_SERVER.id,
    serverName: JELLYFIN_SERVER.name,
    serverType: 'jellyfin',
    ratingKey: hex(n, 32),
    mediaId: uuid(n + 1000),
    imdbId: `tt${String(1000000 + n).padStart(7, '0')}`,
    thumbPath: thumb ? jellyfinThumb(n) : null,
    mirrors: [],
  };
}

/** Every section at its cap, eight seasons per show, hosted Jellyfin poster paths, three links per card, and a window that held more than the caps show. */
export function heaviestDigest(): { data: DigestData; posters: Record<string, PosterRef> } {
  const addedAt = new Date('2026-09-03T12:00:00Z');
  const movies = Array.from({ length: 12 }, (_, i) => ({
    ...card(100 + i, true),
    title: `A Reasonably Long Movie Title Number ${i}`,
    year: 1990 + i,
    genres: ['Action', 'Adventure', 'Science Fiction', 'Thriller'],
    addedAt,
  }));
  const shows = Array.from({ length: 12 }, (_, i) => ({
    ...card(200 + i, true),
    title: `A Long Running Television Series ${i}`,
    year: 2000 + i,
    seasons: Array.from({ length: 8 }, (_, s) => ({
      number: s + 1,
      title: `Season ${s + 1}`,
      episodeRange: 'E01-E04, E07, E09-E12',
      episodeCount: 10,
      whole: false,
    })),
    moreSeasons: 3,
    episodeCount: 110,
    addedAt,
  }));
  const artists = Array.from({ length: 12 }, (_, i) => ({
    ...card(300 + i, false),
    name: `Some Band Called ${i}`,
    albums: [
      {
        ...card(350 + i, true),
        title: 'Album Number 0 With A Long Name',
        year: 2010,
        trackCount: 12,
      },
    ],
  }));
  const mostWatched = Array.from({ length: 10 }, (_, i) => ({
    ...card(400 + i, true),
    kind: i % 2 ? ('show' as const) : ('movie' as const),
    title: `Watched Title ${i}`,
    year: 2020,
    plays: 40 - i,
  }));
  const posters: Record<string, PosterRef> = {};
  const withPoster = [
    ...movies,
    ...shows,
    ...artists.flatMap((a) => (a.albums[0] ? [a.albums[0]] : [])),
    ...mostWatched,
  ];
  for (const c of withPoster) {
    if (c.thumbPath) {
      posters[c.cardId] = {
        serverId: c.serverId,
        thumbPath: c.thumbPath,
        version: posterVersionFor(c.thumbPath),
      };
    }
  }
  return {
    data: {
      movies,
      shows,
      artists,
      mostWatched,
      counts: { movies: 30, shows: 20, episodes: 1320, albums: 20, mostWatched: 10 },
      isEmpty: false,
    },
    posters,
  };
}
