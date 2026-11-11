/**
 * Where a media notification can point: Tracearr's own page for the item, the item in
 * the media server's web client, and IMDb. Each is omitted when what it needs is absent,
 * so a destination renders only the links it actually has.
 */

import { buildMediaServerItemUrl, isServerType, serverLinkBase } from '@tracearr/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { servers } from '../../db/schema.js';
import { getNetworkSettings } from '../settings.js';
import type { MediaEventPayload } from './events.js';

export interface MediaLink {
  label: string;
  url: string;
}

interface ServerLinkRow {
  url: string;
  publicUrl: string | null;
  machineIdentifier: string | null;
}

/** Cached briefly: a burst of media notifications otherwise repeats one point lookup. */
const SERVER_TTL_MS = 30_000;
const serverCache = new Map<string, { row: ServerLinkRow | null; at: number }>();

export function _resetMediaLinkCacheForTests(): void {
  serverCache.clear();
}

async function serverRow(serverId: string): Promise<ServerLinkRow | null> {
  const cached = serverCache.get(serverId);
  if (cached && Date.now() - cached.at < SERVER_TTL_MS) return cached.row;
  const [row] = await db
    .select({
      url: servers.url,
      publicUrl: servers.publicUrl,
      machineIdentifier: servers.machineIdentifier,
    })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  serverCache.set(serverId, { row: row ?? null, at: Date.now() });
  return row ?? null;
}

/**
 * A season carries no IMDb or TMDB id of its own - only the show does - so a season links
 * to Tracearr and the media server and nothing else.
 */
export async function buildMediaLinks(ctx: MediaEventPayload): Promise<MediaLink[]> {
  const links: MediaLink[] = [];

  const { externalUrl } = await getNetworkSettings().catch(() => ({ externalUrl: null }));
  if (externalUrl && ctx.mediaId !== null) {
    links.push({
      label: 'Tracearr',
      url: `${externalUrl.replace(/\/$/, '')}/media/${ctx.mediaId}`,
    });
  }

  if (isServerType(ctx.serverType)) {
    const server = await serverRow(ctx.serverId).catch(() => null);
    const url =
      server &&
      buildMediaServerItemUrl({
        serverType: ctx.serverType,
        baseUrl: serverLinkBase(server),
        ratingKey: ctx.ratingKey,
        machineIdentifier: server.machineIdentifier,
      });
    if (url) links.push({ label: ctx.serverName, url });
  }

  if (ctx.imdbId !== null) {
    links.push({ label: 'IMDb', url: `https://www.imdb.com/title/${ctx.imdbId}/` });
  }

  return links;
}
