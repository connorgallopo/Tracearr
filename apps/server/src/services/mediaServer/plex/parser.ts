/**
 * Plex API Response Parser
 *
 * Pure functions for parsing raw Plex API responses into typed objects.
 * Separated from the client for testability and reuse.
 */

import {
  parseString,
  parseNumber,
  parseBoolean,
  parseOptionalString,
  parseOptionalNumber,
  parseArray,
  parseFirstArrayElement,
} from '../../../utils/parsing.js';
import type { MediaSession, MediaUser, MediaLibrary, MediaWatchHistoryItem } from '../types.js';

// ============================================================================
// Raw Plex API Response Types (for internal use)
// ============================================================================

/** Raw session metadata from Plex API */
export interface PlexRawSession {
  sessionKey?: unknown;
  ratingKey?: unknown;
  title?: unknown;
  type?: unknown;
  duration?: unknown;
  viewOffset?: unknown;
  grandparentTitle?: unknown;
  parentTitle?: unknown;
  grandparentRatingKey?: unknown;
  parentIndex?: unknown;
  index?: unknown;
  year?: unknown;
  thumb?: unknown;
  grandparentThumb?: unknown;
  art?: unknown;
  User?: Record<string, unknown>;
  Player?: Record<string, unknown>;
  Media?: Array<Record<string, unknown>>;
  TranscodeSession?: Record<string, unknown>;
}

// ============================================================================
// Session Parsing
// ============================================================================

/**
 * Parse Plex media type to unified type
 */
function parseMediaType(type: unknown): MediaSession['media']['type'] {
  const typeStr = parseString(type).toLowerCase();
  switch (typeStr) {
    case 'movie':
      return 'movie';
    case 'episode':
      return 'episode';
    case 'track':
      return 'track';
    case 'photo':
      return 'photo';
    default:
      return 'unknown';
  }
}

/**
 * Parse player state from Plex to unified state
 */
function parsePlaybackState(state: unknown): MediaSession['playback']['state'] {
  const stateStr = parseString(state, 'playing').toLowerCase();
  switch (stateStr) {
    case 'paused':
      return 'paused';
    case 'buffering':
      return 'buffering';
    default:
      return 'playing';
  }
}

/**
 * Calculate progress percentage from position and duration
 */
function calculateProgress(positionMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.min(100, Math.round((positionMs / durationMs) * 100));
}

/**
 * Parse raw Plex session data into a MediaSession object
 */
export function parseSession(item: Record<string, unknown>): MediaSession {
  const player = (item.Player as Record<string, unknown>) ?? {};
  const user = (item.User as Record<string, unknown>) ?? {};
  const sessionInfo = (item.Session as Record<string, unknown>) ?? {};
  const transcodeSession = item.TranscodeSession as Record<string, unknown> | undefined;

  const durationMs = parseNumber(item.duration);
  const positionMs = parseNumber(item.viewOffset);
  const mediaType = parseMediaType(item.type);

  // Get bitrate and resolution from Media array (first element)
  const bitrate = parseNumber(parseFirstArrayElement(item.Media, 'bitrate'));
  const videoResolution = parseOptionalString(
    parseFirstArrayElement(item.Media, 'videoResolution')
  );
  const videoHeight = parseOptionalNumber(parseFirstArrayElement(item.Media, 'height'));

  // Determine transcode status - check both video and audio decisions
  const videoDecision = parseString(transcodeSession?.videoDecision, 'directplay');
  const audioDecision = parseString(transcodeSession?.audioDecision, 'directplay');
  // isTranscode = true if either video or audio is being transcoded (not just copied/remuxed)
  const isTranscode =
    (videoDecision !== 'directplay' && videoDecision !== 'copy') ||
    (audioDecision !== 'directplay' && audioDecision !== 'copy');

  const session: MediaSession = {
    sessionKey: parseString(item.sessionKey),
    mediaId: parseString(item.ratingKey),
    user: {
      id: parseString(user.id),
      username: parseString(user.title),
      thumb: parseOptionalString(user.thumb),
    },
    media: {
      title: parseString(item.title),
      type: mediaType,
      durationMs,
      year: parseOptionalNumber(item.year),
      thumbPath: parseOptionalString(item.thumb),
    },
    playback: {
      state: parsePlaybackState(player.state),
      positionMs,
      progressPercent: calculateProgress(positionMs, durationMs),
    },
    player: {
      name: parseString(player.title),
      deviceId: parseString(player.machineIdentifier),
      product: parseOptionalString(player.product),
      device: parseOptionalString(player.device),
      platform: parseOptionalString(player.platform),
    },
    network: {
      // Prefer remote public IP for geo, fall back to local IP
      ipAddress: parseString(player.remotePublicAddress) || parseString(player.address),
      isLocal: parseBoolean(player.local),
    },
    quality: {
      bitrate,
      isTranscode,
      videoDecision,
      audioDecision,
      videoResolution,
      videoHeight,
    },
    // Plex termination API requires Session.id, not sessionKey
    plexSessionId: parseOptionalString(sessionInfo.id),
  };

  // Add episode-specific metadata if this is an episode
  if (mediaType === 'episode') {
    session.episode = {
      showTitle: parseString(item.grandparentTitle),
      showId: parseOptionalString(item.grandparentRatingKey),
      seasonNumber: parseNumber(item.parentIndex),
      episodeNumber: parseNumber(item.index),
      seasonName: parseOptionalString(item.parentTitle),
      showThumbPath: parseOptionalString(item.grandparentThumb),
    };
  }

  return session;
}

/**
 * Parse Plex sessions API response
 */
export function parseSessionsResponse(data: unknown): MediaSession[] {
  const container = data as { MediaContainer?: { Metadata?: unknown[] } };
  const metadata = container?.MediaContainer?.Metadata;
  return parseArray(metadata, (item) => parseSession(item as Record<string, unknown>));
}

// ============================================================================
// User Parsing
// ============================================================================

/**
 * Parse raw Plex user data into a MediaUser object
 * Used for local server accounts from /accounts endpoint
 */
export function parseLocalUser(user: Record<string, unknown>): MediaUser {
  const userId = parseString(user.id);
  return {
    id: userId,
    username: parseString(user.name),
    email: undefined, // Local accounts don't have email
    thumb: parseOptionalString(user.thumb),
    // Account ID 1 is typically the owner
    isAdmin: userId === '1' || parseNumber(user.id) === 1,
    isDisabled: false,
  };
}

/**
 * Parse Plex.tv user data into a MediaUser object
 * Used for users from plex.tv API endpoints
 */
export function parsePlexTvUser(
  user: Record<string, unknown>,
  sharedLibraries?: string[]
): MediaUser {
  return {
    id: parseString(user.id),
    username: parseString(user.username) || parseString(user.title),
    email: parseOptionalString(user.email),
    thumb: parseOptionalString(user.thumb),
    isAdmin: parseBoolean(user.isAdmin),
    isDisabled: false,
    isHomeUser: parseBoolean(user.home) || parseBoolean(user.isHomeUser),
    sharedLibraries: sharedLibraries ?? [],
  };
}

/**
 * Parse Plex local accounts API response
 */
export function parseUsersResponse(data: unknown): MediaUser[] {
  const container = data as { MediaContainer?: { Account?: unknown[] } };
  const accounts = container?.MediaContainer?.Account;
  return parseArray(accounts, (user) => parseLocalUser(user as Record<string, unknown>));
}

// ============================================================================
// Library Parsing
// ============================================================================

/**
 * Parse raw Plex library data into a MediaLibrary object
 */
export function parseLibrary(dir: Record<string, unknown>): MediaLibrary {
  return {
    id: parseString(dir.key),
    name: parseString(dir.title),
    type: parseString(dir.type),
    agent: parseOptionalString(dir.agent),
    scanner: parseOptionalString(dir.scanner),
  };
}

/**
 * Parse Plex libraries API response
 */
export function parseLibrariesResponse(data: unknown): MediaLibrary[] {
  const container = data as { MediaContainer?: { Directory?: unknown[] } };
  const directories = container?.MediaContainer?.Directory;
  return parseArray(directories, (dir) => parseLibrary(dir as Record<string, unknown>));
}

// ============================================================================
// Watch History Parsing
// ============================================================================

/**
 * Parse raw Plex watch history item
 */
export function parseWatchHistoryItem(item: Record<string, unknown>): MediaWatchHistoryItem {
  const mediaType = parseMediaType(item.type);

  const historyItem: MediaWatchHistoryItem = {
    mediaId: parseString(item.ratingKey),
    title: parseString(item.title),
    type: mediaType === 'photo' ? 'unknown' : mediaType,
    // Plex returns Unix timestamp
    watchedAt: parseNumber(item.lastViewedAt) || parseNumber(item.viewedAt),
    userId: parseOptionalString(item.accountID),
  };

  // Add episode metadata if applicable
  if (mediaType === 'episode') {
    historyItem.episode = {
      showTitle: parseString(item.grandparentTitle),
      seasonNumber: parseOptionalNumber(item.parentIndex),
      episodeNumber: parseOptionalNumber(item.index),
    };
  }

  return historyItem;
}

/**
 * Parse Plex watch history API response
 */
export function parseWatchHistoryResponse(data: unknown): MediaWatchHistoryItem[] {
  const container = data as { MediaContainer?: { Metadata?: unknown[] } };
  const metadata = container?.MediaContainer?.Metadata;
  return parseArray(metadata, (item) => parseWatchHistoryItem(item as Record<string, unknown>));
}

// ============================================================================
// Server Resource Parsing (for plex.tv API)
// ============================================================================

/**
 * Server connection details
 */
export interface PlexServerConnection {
  protocol: string;
  address: string;
  port: number;
  uri: string;
  local: boolean;
}

/**
 * Server resource from plex.tv
 */
export interface PlexServerResource {
  name: string;
  product: string;
  productVersion: string;
  platform: string;
  clientIdentifier: string;
  owned: boolean;
  accessToken: string;
  publicAddress: string;
  /**
   * True if the requesting client's public IP matches the server's public IP.
   * Used to determine which connections are reachable:
   * - true: client is on same network, local connections will work
   * - false: client is remote, only remote connections will work
   */
  publicAddressMatches: boolean;
  /**
   * True if the server requires HTTPS connections.
   * When true, HTTP connections will be rejected by the server.
   */
  httpsRequired: boolean;
  connections: PlexServerConnection[];
}

/**
 * Parse server connection
 */
export function parseServerConnection(conn: Record<string, unknown>): PlexServerConnection {
  return {
    protocol: parseString(conn.protocol, 'http'),
    address: parseString(conn.address),
    port: parseNumber(conn.port, 32400),
    uri: parseString(conn.uri),
    local: parseBoolean(conn.local),
  };
}

/**
 * Parse server resource from plex.tv resources API
 *
 * Filters connections based on:
 * - httpsRequired: If true, only HTTPS connections are usable (HTTP will be rejected)
 * - publicAddressMatches: If false (different network), only remote connections work
 */
export function parseServerResource(
  resource: Record<string, unknown>,
  fallbackToken: string
): PlexServerResource {
  const publicAddressMatches = parseBoolean(resource.publicAddressMatches);
  const httpsRequired = parseBoolean(resource.httpsRequired);

  // Parse all connections
  const allConnections = parseArray(resource.connections, (conn) =>
    parseServerConnection(conn as Record<string, unknown>)
  );

  // Filter connections based on what's actually usable
  const connections = allConnections.filter((conn) => {
    // If HTTPS is required, filter out HTTP connections
    if (httpsRequired && conn.protocol !== 'https') {
      return false;
    }

    // Filter based on network location (like Tautulli does)
    if (publicAddressMatches) {
      // Same network: all connections should work
      return true;
    } else {
      // Different network: only remote connections will work (local IPs unreachable)
      return !conn.local;
    }
  });

  // If filtering removed all connections, fall back to showing all
  // (better to let user try than show nothing)
  const filteredConnections = connections.length > 0 ? connections : allConnections;

  // Sort connections: HTTPS first, then local preference for same-network scenarios
  const finalConnections = [...filteredConnections].sort((a, b) => {
    // HTTPS first
    const aHttps = a.protocol === 'https';
    const bHttps = b.protocol === 'https';
    if (aHttps !== bHttps) return aHttps ? -1 : 1;
    // Then local preference (local connections are typically faster)
    if (a.local !== b.local) return a.local ? -1 : 1;
    return 0;
  });

  return {
    name: parseString(resource.name, 'Plex Server'),
    product: parseString(resource.product),
    productVersion: parseString(resource.productVersion),
    platform: parseString(resource.platform),
    clientIdentifier: parseString(resource.clientIdentifier),
    owned: parseBoolean(resource.owned),
    accessToken: parseString(resource.accessToken) || fallbackToken,
    publicAddress: parseString(resource.publicAddress),
    publicAddressMatches,
    httpsRequired,
    connections: finalConnections,
  };
}

/**
 * Parse and filter plex.tv resources for owned Plex Media Servers
 */
export function parseServerResourcesResponse(
  data: unknown,
  fallbackToken: string
): PlexServerResource[] {
  if (!Array.isArray(data)) return [];

  return data
    .filter(
      (r) =>
        (r as Record<string, unknown>).provides === 'server' &&
        (r as Record<string, unknown>).owned === true &&
        (r as Record<string, unknown>).product === 'Plex Media Server'
    )
    .map((r) => parseServerResource(r as Record<string, unknown>, fallbackToken));
}

// ============================================================================
// XML Parsing Helpers (for plex.tv endpoints that return XML)
// ============================================================================

/**
 * Extract attribute value from XML string
 */
export function extractXmlAttribute(xml: string, attr: string): string {
  const match = xml.match(new RegExp(`${attr}="([^"]+)"`));
  return match?.[1] ?? '';
}

/**
 * Extract ID attribute (handles both 'id' and ' id' patterns)
 */
export function extractXmlId(xml: string): string {
  const match = xml.match(/(?:^|\s)id="([^"]+)"/);
  return match?.[1] ?? '';
}

/**
 * Parse a user from XML (from /api/users endpoint)
 */
export function parseXmlUser(userXml: string): MediaUser {
  return {
    id: extractXmlId(userXml),
    username: extractXmlAttribute(userXml, 'username') || extractXmlAttribute(userXml, 'title'),
    email: extractXmlAttribute(userXml, 'email') || undefined,
    thumb: extractXmlAttribute(userXml, 'thumb') || undefined,
    isAdmin: false,
    isHomeUser: extractXmlAttribute(userXml, 'home') === '1',
    sharedLibraries: [],
  };
}

/**
 * Parse users from XML response (plex.tv /api/users)
 */
export function parseXmlUsersResponse(xml: string): MediaUser[] {
  const userMatches = Array.from(xml.matchAll(/<User[^>]*(?:\/>|>[\s\S]*?<\/User>)/g));
  return userMatches.map((match) => parseXmlUser(match[0]));
}

/**
 * Parse shared server info from XML (plex.tv /api/servers/{id}/shared_servers)
 */
export function parseSharedServersXml(
  xml: string
): Map<string, { serverToken: string; sharedLibraries: string[] }> {
  const userMap = new Map<string, { serverToken: string; sharedLibraries: string[] }>();
  const serverMatches = Array.from(xml.matchAll(/<SharedServer[^>]*>[\s\S]*?<\/SharedServer>/g));

  for (const match of serverMatches) {
    const serverXml = match[0];
    const userId = extractXmlAttribute(serverXml, 'userID');
    const serverToken = extractXmlAttribute(serverXml, 'accessToken');

    // Get shared libraries - sections with shared="1"
    const sectionMatches = Array.from(serverXml.matchAll(/<Section[^>]*shared="1"[^>]*>/g));
    const sharedLibraries = sectionMatches
      .map((sectionMatch) => extractXmlAttribute(sectionMatch[0], 'key'))
      .filter((key): key is string => key !== '');

    if (userId) {
      userMap.set(userId, { serverToken, sharedLibraries });
    }
  }

  return userMap;
}

// ============================================================================
// Server Resource Statistics Parsing
// ============================================================================

/** Raw statistics resource data point from Plex API */
interface PlexRawStatisticsResource {
  at?: unknown;
  timespan?: unknown;
  hostCpuUtilization?: unknown;
  processCpuUtilization?: unknown;
  hostMemoryUtilization?: unknown;
  processMemoryUtilization?: unknown;
}

/** Parsed statistics data point */
export interface PlexStatisticsDataPoint {
  at: number;
  timespan: number;
  hostCpuUtilization: number;
  processCpuUtilization: number;
  hostMemoryUtilization: number;
  processMemoryUtilization: number;
}

/**
 * Parse a single statistics resource data point
 */
function parseStatisticsDataPoint(raw: PlexRawStatisticsResource): PlexStatisticsDataPoint {
  return {
    at: parseNumber(raw.at),
    timespan: parseNumber(raw.timespan, 6),
    hostCpuUtilization: parseNumber(raw.hostCpuUtilization, 0),
    processCpuUtilization: parseNumber(raw.processCpuUtilization, 0),
    hostMemoryUtilization: parseNumber(raw.hostMemoryUtilization, 0),
    processMemoryUtilization: parseNumber(raw.processMemoryUtilization, 0),
  };
}

/**
 * Parse statistics resources response from /statistics/resources endpoint
 * Returns array of data points sorted by timestamp (newest first)
 */
export function parseStatisticsResourcesResponse(data: unknown): PlexStatisticsDataPoint[] {
  if (!data || typeof data !== 'object') {
    return [];
  }

  const container = (data as Record<string, unknown>).MediaContainer;
  if (!container || typeof container !== 'object') {
    return [];
  }

  const rawStats = (container as Record<string, unknown>).StatisticsResources;

  return parseArray(rawStats, (item) =>
    parseStatisticsDataPoint(item as PlexRawStatisticsResource)
  ).sort((a, b) => b.at - a.at); // Sort newest first
}
