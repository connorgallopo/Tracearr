/**
 * One fake per media server type, answering every IMediaServerClient method the way that
 * server's real client does. Defaults come from recorded responses (mediaServerResponses/),
 * sanitized and run through the real parsers; pass a vi.fn override for what a test controls.
 */

import { vi } from 'vitest';
import type { JellyfinEmbyServerType } from '@tracearr/shared';
import * as plexParser from '../services/mediaServer/plex/parser.js';
import { parseSessionsResponse as parseJellyfinSessions } from '../services/mediaServer/jellyfin/parser.js';
import { parseSessionsResponse as parseEmbySessions } from '../services/mediaServer/emby/parser.js';
import {
  parseLibrariesResponse,
  parseLibraryItemsResponse,
  parseUsersResponse,
} from '../services/mediaServer/shared/jellyfinEmbyParser.js';
import {
  NOT_NEEDED,
  type IMediaServerClient,
  type MediaLibraryItem,
  type MediaSession,
  type NotNeeded,
} from '../services/mediaServer/types.js';
import { normalizeClient } from '../utils/platformNormalizer.js';
import plex from './mediaServerResponses/plex.json' with { type: 'json' };
import jellyfin from './mediaServerResponses/jellyfin.json' with { type: 'json' };
import emby from './mediaServerResponses/emby.json' with { type: 'json' };

type Overrides = Partial<Omit<IMediaServerClient, 'serverType'>>;
type Paging = { offset?: number; limit?: number };
type PlexListing = { MediaContainer: { totalSize: number; Metadata: unknown[] } };
type JellyfinEmbyListing = { Items: unknown[]; TotalRecordCount: number };

const plexListings: Record<string, Record<string, PlexListing>> = {
  items: plex.items,
  leaves: plex.leaves,
  seasons: plex.seasons,
  albums: plex.albums,
};

function plexPage(listing: PlexListing | undefined, paging?: Paging) {
  if (!listing) return { items: [], totalCount: 0 };
  const offset = paging?.offset ?? 0;
  const metadata = listing.MediaContainer.Metadata.slice(offset, offset + (paging?.limit ?? 100));
  return {
    items: plexParser.parseLibraryItemsResponse({
      MediaContainer: { ...listing.MediaContainer, Metadata: metadata },
    }),
    totalCount: listing.MediaContainer.totalSize,
  };
}

// Plex answers these newest first, by updatedAt
function plexSince(listing: PlexListing | undefined, since: Date) {
  const updatedUnix = (item: MediaLibraryItem) =>
    item.updatedAt ? Math.floor(item.updatedAt.getTime() / 1000) : 0;
  const sinceUnix = Math.floor(since.getTime() / 1000);
  const items = plexPage(listing, { limit: Infinity })
    .items.filter((item) => updatedUnix(item) >= sinceUnix)
    .sort((a, b) => updatedUnix(b) - updatedUnix(a));
  return { items, totalCount: items.length };
}

function plexSessions(sessionKey?: string): MediaSession[] {
  const data = sessionKey ? plexParser.keepSession(plex.sessions, sessionKey) : plex.sessions;
  const original = new Map<string, plexParser.PlexOriginalMedia>();
  const recordedKey = plex.sessionMetadata.MediaContainer.Metadata[0]?.ratingKey;
  for (const { ratingKey, sessionMediaId } of plexParser.getTranscodingSessionRatingKeys(data)) {
    const parsed =
      ratingKey === recordedKey
        ? plexParser.parseMediaMetadataResponse(plex.sessionMetadata, sessionMediaId)
        : null;
    if (parsed) original.set(sessionMediaId ? `${ratingKey}:${sessionMediaId}` : ratingKey, parsed);
  }
  return plexParser.parseSessionsResponse(data, original);
}

export function fakePlexClient(overrides: Overrides = {}): IMediaServerClient {
  const keysIn = (libraryId: string) =>
    new Set(
      Object.values(plexListings).flatMap((listings) =>
        plexPage(listings[libraryId], { limit: Infinity }).items.map((item) => item.ratingKey)
      )
    );
  return {
    serverType: 'plex',
    getSessions: vi.fn(async (sessionKey?: string) => plexSessions(sessionKey)),
    getUsers: vi.fn(async () => plexParser.parseUsersResponse(plex.accounts)),
    getLibraries: vi.fn(async () => plexParser.parseLibrariesResponse(plex.sections)),
    testConnection: vi.fn(async () => true),
    getServerIdentity: vi.fn(async () => plex.identity.MediaContainer.machineIdentifier),
    getSoftwareVersion: vi.fn(async () => plex.identity.MediaContainer.version),
    describeDownloadSource: vi.fn(async (request) => ({
      version: null,
      delivered: null,
      device: { deviceId: request.deviceId, playerName: null, product: null, platform: null },
      ipAddress: null,
    })),
    terminateSession: vi.fn(async () => true),
    getLibraryItems: vi.fn(async (libraryId: string, paging?: Paging) =>
      plexPage(plexListings.items?.[libraryId], paging)
    ),
    findExistingRatingKeys: vi.fn(async (ratingKeys: string[], library) => {
      const known = keysIn(library.id);
      return new Set(ratingKeys.filter((key) => known.has(key)));
    }),
    getLibraryLeaves: vi.fn(async (libraryId: string, paging?: Paging) =>
      plexPage(plexListings.leaves?.[libraryId], paging)
    ),
    getLibraryItemsSince: vi.fn(async (libraryId: string, since: Date) =>
      plexSince(plexListings.items?.[libraryId], since)
    ),
    getLibraryLeavesSince: vi.fn(async (libraryId: string, since: Date) =>
      plexSince(plexListings.leaves?.[libraryId], since)
    ),
    getLibrarySeasons: vi.fn(async (libraryId: string, paging?: Paging) =>
      plexPage(plexListings.seasons?.[libraryId], paging)
    ),
    getLibrarySeasonsSince: vi.fn(async (libraryId: string, since: Date) =>
      plexSince(plexListings.seasons?.[libraryId], since)
    ),
    getLibraryAlbums: vi.fn(async (libraryId: string, paging?: Paging) =>
      plexPage(plexListings.albums?.[libraryId], paging)
    ),
    getLibraryAlbumsSince: vi.fn(async (libraryId: string, since: Date) =>
      plexSince(plexListings.albums?.[libraryId], since)
    ),
    checkFilesExist: vi.fn(
      async (ratingKeys: string[]) =>
        new Map(
          [...plexParser.parseFileExistence(plex.checkFiles)].filter(([key]) =>
            ratingKeys.includes(key)
          )
        )
    ),
    ...overrides,
  };
}

interface JellyfinEmbyResponses {
  systemInfo: { Id: string; Version: string };
  users: unknown[];
  libraries: unknown[];
  sessions: unknown[];
  items: Record<string, JellyfinEmbyListing>;
  leaves: Record<string, JellyfinEmbyListing>;
}

function jellyfinEmbyPage(listing: JellyfinEmbyListing | undefined, paging?: Paging) {
  const offset = paging?.offset ?? 0;
  const raw = listing?.Items.slice(offset, offset + (paging?.limit ?? 100)) ?? [];
  const items = parseLibraryItemsResponse(raw);
  return { items, totalCount: listing?.TotalRecordCount ?? items.length, rawCount: raw.length };
}

// Jellyfin and Emby answer these newest first, by DateCreated
function addedSince(listing: JellyfinEmbyListing | undefined, since: Date) {
  const items = parseLibraryItemsResponse(listing?.Items ?? [])
    .filter((item) => item.addedAt >= since)
    .sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime());
  return { items, totalCount: items.length };
}

function fakeJellyfinEmbyClient(
  serverType: JellyfinEmbyServerType,
  responses: JellyfinEmbyResponses,
  parseSessions: (sessions: unknown[]) => MediaSession[],
  overrides: Overrides
): IMediaServerClient {
  return {
    serverType,
    getSessions: vi.fn(async () => parseSessions(responses.sessions)),
    getUsers: vi.fn(async () => parseUsersResponse(responses.users)),
    getLibraries: vi.fn(async () => parseLibrariesResponse(responses.libraries)),
    testConnection: vi.fn(async () => true),
    getServerIdentity: vi.fn(async () => responses.systemInfo.Id),
    getSoftwareVersion: vi.fn(async () => responses.systemInfo.Version),
    // The answer when the server has no record of the item or a session for the device
    describeDownloadSource: vi.fn(async (request) => ({
      version: null,
      delivered: null,
      device: request.deviceId
        ? {
            deviceId: request.deviceId,
            playerName: request.device,
            product: request.app,
            platform: request.app
              ? normalizeClient(request.app, undefined, serverType).platform
              : null,
          }
        : { deviceId: null, playerName: null, product: null, platform: null },
      ipAddress: null,
    })),
    terminateSession: vi.fn(async () => true),
    getLibraryItems: vi.fn(async (libraryId: string, paging?: Paging) =>
      jellyfinEmbyPage(responses.items[libraryId], paging)
    ),
    findExistingRatingKeys: vi.fn(async (ratingKeys: string[], library) => {
      const known = new Set(
        [responses.items[library.id], responses.leaves[library.id]].flatMap((listing) =>
          parseLibraryItemsResponse(listing?.Items ?? []).map((item) => item.ratingKey)
        )
      );
      return new Set(ratingKeys.filter((key) => known.has(key)));
    }),
    getLibraryLeaves: vi.fn(async (libraryId: string, paging?: Paging) =>
      jellyfinEmbyPage(responses.leaves[libraryId], paging)
    ),
    getLibraryItemsSince: vi.fn(async (libraryId: string, since: Date) =>
      addedSince(responses.items[libraryId], since)
    ),
    getLibraryLeavesSince: vi.fn(async (libraryId: string, since: Date) =>
      addedSince(responses.leaves[libraryId], since)
    ),
    getLibrarySeasons: vi.fn(async (): Promise<NotNeeded> => NOT_NEEDED),
    getLibrarySeasonsSince: vi.fn(async (): Promise<NotNeeded> => NOT_NEEDED),
    getLibraryAlbums: vi.fn(async (): Promise<NotNeeded> => NOT_NEEDED),
    getLibraryAlbumsSince: vi.fn(async (): Promise<NotNeeded> => NOT_NEEDED),
    checkFilesExist: vi.fn(async (): Promise<NotNeeded> => NOT_NEEDED),
    ...overrides,
  };
}

export function fakeJellyfinClient(overrides: Overrides = {}): IMediaServerClient {
  return fakeJellyfinEmbyClient('jellyfin', jellyfin, parseJellyfinSessions, overrides);
}

export function fakeEmbyClient(overrides: Overrides = {}): IMediaServerClient {
  return fakeJellyfinEmbyClient('emby', emby, parseEmbySessions, overrides);
}
