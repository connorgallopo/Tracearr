import {
  POSTER_IMAGE_SIZE,
  buildMediaServerItemUrl,
  memberFacingUrl,
  type EmailBrandingSettings,
  type EmailRichTextDoc,
  type NewsletterImageMode,
  type ServerType,
} from '@tracearr/shared';
import type { DigestInput, EmailLink, RichTextDoc } from '@tracearr/emails';
import type { PosterRef } from '../../db/schema.js';
import { buildProxyUrl } from '../imageProxy.js';
import { sectionItemCounts, type DigestCard, type DigestData } from './assemble.js';
import type { ServerLink } from './store.js';

export type ResolvedImageMode = 'hosted' | 'inline' | 'none';

/** packages/emails declares the grammar it renders and cannot depend on shared; a drift between the two turns this into never and the callers below stop compiling. */
export type RenderableDoc = EmailRichTextDoc extends RichTextDoc ? EmailRichTextDoc : never;

export interface DigestLinkOptions {
  tracearr: boolean;
  imdb?: boolean;
}

/** Written into the snapshot at render time and replaced per recipient at delivery. */
export const UNSUBSCRIBE_PLACEHOLDER = '{{unsubscribe_url}}';
export const VIEW_PLACEHOLDER = '{{view_url}}';
/** Serves data/logo.png when the owner installed one; the browser surfaces use it relative to the app origin. */
export const LOGO_ROUTE = '/api/v1/images/logo';

/** The owner's URL in every mode but none; the Tracearr PNG inline or hosted; nothing when images are off. */
export function logoRefFor(
  logo: EmailBrandingSettings['logo'],
  mode: ResolvedImageMode,
  base: string,
  hasPng: boolean
): string | null {
  if (mode === 'none' || logo.mode === 'none') return null;
  if (logo.mode === 'url') return logo.url;
  if (!hasPng) return null;
  return mode === 'hosted' ? `${base}${LOGO_ROUTE}` : 'cid:logo';
}

/** Hosted needs a reachable external URL and stays opt-in; auto is inline because that works everywhere. */
export function resolveImageMode(
  mode: NewsletterImageMode,
  externalUrl: string | null
): ResolvedImageMode {
  if (mode === 'none') return 'none';
  if (mode === 'hosted' && externalUrl) return 'hosted';
  return 'inline';
}

export function formatWindowDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

const POSTER_IMG = /<img\b[^>]*\bsrc="poster:([A-Za-z0-9_-]+)"[^>]*>/g;

export function substitutePosterRefs(
  html: string,
  posters: Record<string, PosterRef>,
  mode: ResolvedImageMode,
  externalUrl: string | null
): string {
  const base = externalUrl?.replace(/\/$/, '') ?? '';
  return html.replace(POSTER_IMG, (tag, cardId: string) => {
    const poster = posters[cardId];
    if (!poster || mode === 'none') return '';
    const src =
      mode === 'inline'
        ? `cid:${cardId}`
        : `${base}${buildProxyUrl({ serverId: poster.serverId, path: poster.thumbPath, ...POSTER_IMAGE_SIZE, fallback: 'poster', version: poster.version })}`;
    return tag.replace(`src="poster:${cardId}"`, `src="${src}"`);
  });
}

const SERVER_TYPES = new Set<string>(['plex', 'jellyfin', 'emby']);

/** The item on its media server: Plex routes through app.plex.tv; a Jellyfin or Emby link opens on the server itself and needs an address members can reach. */
function serverItemLink(server: ServerLink, ratingKey: string): EmailLink | null {
  if (!SERVER_TYPES.has(server.type) || !ratingKey) return null;
  const baseUrl = server.type === 'plex' ? server.url : memberFacingUrl(server);
  if (baseUrl === null) return null;
  const url = buildMediaServerItemUrl({
    serverType: server.type as ServerType,
    baseUrl,
    ratingKey,
    machineIdentifier: server.machineIdentifier,
  });
  return url ? { label: server.name, url } : null;
}

/** Tracearr's own page when the owner turned links on and the URL is reachable, the item on every server that has it, and IMDb when the id is known. */
export function digestLinks(
  card: DigestCard,
  externalUrl: string | null,
  serversById: Map<string, ServerLink>,
  opts: DigestLinkOptions
): EmailLink[] {
  const links: EmailLink[] = [];
  if (opts.tracearr && externalUrl && card.mediaId) {
    links.push({
      label: 'Tracearr',
      url: `${externalUrl.replace(/\/$/, '')}/media/${card.mediaId}`,
    });
  }
  for (const copy of [{ serverId: card.serverId, ratingKey: card.ratingKey }, ...card.mirrors]) {
    const server = serversById.get(copy.serverId);
    const link = server ? serverItemLink(server, copy.ratingKey) : null;
    if (link) links.push(link);
  }
  if ((opts.imdb ?? true) && card.imdbId)
    links.push({ label: 'IMDb', url: `https://www.imdb.com/title/${card.imdbId}/` });
  return links;
}

export interface DigestInputOptions {
  subject: string;
  intro: RenderableDoc | null;
  outro: RenderableDoc | null;
  windowStart: string;
  windowEnd: string;
  logoRef: string | null;
  unsubscribeUrl: string | null;
  viewUrl: string | null;
  externalUrl: string | null;
  tracearrLinks: boolean;
  serversById: Map<string, ServerLink>;
  /** False for a test send: it goes to the owner's own address, not because they are a member. */
  memberSend: boolean;
}

export function buildDigestInput(
  data: DigestData,
  posters: Record<string, PosterRef>,
  opts: DigestInputOptions
): DigestInput {
  const shown = sectionItemCounts(data);
  const servers = [...opts.serversById.values()];
  const ref = (card: DigestCard): string | null =>
    posters[card.cardId] ? `poster:${card.cardId}` : null;
  const links = (card: DigestCard) =>
    digestLinks(card, opts.externalUrl, opts.serversById, { tracearr: opts.tracearrLinks });
  const serverName = (card: DigestCard): string =>
    [card.serverName, ...card.mirrors.map((m) => opts.serversById.get(m.serverId)?.name)]
      .filter((name): name is string => Boolean(name))
      .join(', ');
  return {
    subject: opts.subject,
    intro: opts.intro,
    outro: opts.outro,
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
    movies: data.movies.map((m) => ({
      id: m.cardId,
      title: m.title,
      year: m.year,
      posterRef: ref(m),
      genres: m.genres,
      serverName: serverName(m),
      links: links(m),
    })),
    shows: data.shows.map((s) => ({
      id: s.cardId,
      title: s.title,
      year: s.year,
      posterRef: ref(s),
      seasons: s.seasons.map((x) => ({
        number: x.number,
        title: x.title,
        episodeRange: x.episodeRange,
        episodeCount: x.episodeCount,
        whole: x.whole,
      })),
      moreSeasons: s.moreSeasons,
      episodeCount: s.episodeCount,
      serverName: serverName(s),
      links: links(s),
    })),
    artists: data.artists.map((a) => ({
      id: a.cardId,
      name: a.name,
      posterRef: a.albums[0] ? ref(a.albums[0]) : null,
      albums: a.albums.map((al) => ({
        id: al.cardId,
        title: al.title,
        year: al.year,
        trackCount: al.trackCount,
      })),
      serverName: serverName(a),
      links: links(a),
    })),
    mostWatched: data.mostWatched.map((w) => ({
      id: w.cardId,
      kind: w.kind,
      title: w.title,
      year: w.year,
      plays: w.plays,
      posterRef: ref(w),
      serverName: serverName(w),
      links: digestLinks(w, opts.externalUrl, opts.serversById, {
        tracearr: opts.tracearrLinks,
        imdb: false,
      }),
    })),
    episodes: data.counts.episodes,
    moreMovies: data.counts.movies - shown.movies,
    moreShows: data.counts.shows - shown.shows,
    moreAlbums: data.counts.albums - shown.albums,
    moreWatched: data.counts.mostWatched - shown.mostWatched,
    logoRef: opts.logoRef,
    unsubscribeUrl: opts.unsubscribeUrl,
    viewUrl: opts.viewUrl,
    multiServer: servers.length > 1,
    serverNames: servers.map((s) => s.name),
    memberSend: opts.memberSend,
  };
}
