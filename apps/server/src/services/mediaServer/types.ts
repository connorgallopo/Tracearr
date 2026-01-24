/**
 * Media Server Integration Types
 *
 * Common interfaces for Plex and Jellyfin media server integrations.
 * Enables code reuse across different media server implementations.
 */

import type {
  ServerType,
  SourceVideoDetails,
  SourceAudioDetails,
  StreamVideoDetails,
  StreamAudioDetails,
  TranscodeInfo,
  SubtitleInfo,
} from '@tracearr/shared';

// ============================================================================
// Session Types
// ============================================================================

/**
 * Unified session representation across media servers
 * Contains common fields needed for session tracking and display
 */
export interface MediaSession {
  /** Unique session identifier from media server */
  sessionKey: string;

  /** Media item identifier (ratingKey for Plex, itemId for Jellyfin) */
  mediaId: string;

  /** User information */
  user: {
    id: string;
    username: string;
    thumb?: string;
  };

  /** Media metadata */
  media: {
    title: string;
    type: 'movie' | 'episode' | 'track' | 'live' | 'photo' | 'trailer' | 'unknown';
    /** Duration in milliseconds */
    durationMs: number;
    /** Release year */
    year?: number;
    /** Poster/thumbnail path */
    thumbPath?: string;
  };

  /** Episode-specific metadata (only present for episodes) */
  episode?: {
    showTitle: string;
    showId?: string;
    seasonNumber: number;
    episodeNumber: number;
    /** Season name (e.g., "Season 1") */
    seasonName?: string;
    /** Show poster path */
    showThumbPath?: string;
  };

  /** Live TV-specific metadata (only present for live TV streams) */
  live?: {
    /** Channel name (e.g., "HBO", "ESPN") */
    channelTitle: string;
    /** Channel number or identifier */
    channelIdentifier?: string;
    /** Channel logo/thumbnail path */
    channelThumb?: string;
  };

  /** Music track metadata (only present for tracks) */
  music?: {
    /** Artist name (undefined if unknown) */
    artistName?: string;
    /** Album name */
    albumName?: string;
    /** Track number in album */
    trackNumber?: number;
    /** Disc number for multi-disc albums */
    discNumber?: number;
  };

  /** Playback state */
  playback: {
    state: 'playing' | 'paused' | 'buffering';
    /** Current position in milliseconds */
    positionMs: number;
    /** Progress percentage (0-100) */
    progressPercent: number;
  };

  /** Player/device information */
  player: {
    /** Friendly device name */
    name: string;
    /** Unique device identifier */
    deviceId: string;
    /** Product/app name (e.g., "Plex for iOS") */
    product?: string;
    /** Device type (e.g., "iPhone") */
    device?: string;
    /** Platform (e.g., "iOS") */
    platform?: string;
  };

  /** Network information */
  network: {
    /** Client IP address (prefer public IP for geo) */
    ipAddress: string;
    /** Whether client is on local network */
    isLocal: boolean;
  };

  /** Stream quality information */
  quality: {
    /** Bitrate in kbps */
    bitrate: number;
    /** Whether stream is being transcoded (video or audio) */
    isTranscode: boolean;
    /** Video decision: 'directplay' | 'copy' | 'transcode' */
    videoDecision: string;
    /** Audio decision: 'directplay' | 'copy' | 'transcode' */
    audioDecision: string;
    /** Video resolution (e.g., "4k", "1080", "720", "480", "sd") */
    videoResolution?: string;
    /** Video width in pixels (preferred for resolution calculation - handles widescreen) */
    videoWidth?: number;
    /** Video height in pixels (fallback for resolution calculation) */
    videoHeight?: number;

    // ============ Source Media Details (Original file) ============
    /** Source video codec (H264, HEVC, VP9, AV1) */
    sourceVideoCodec?: string;
    /** Source audio codec (TrueHD, DTS-HD MA, AAC, FLAC) */
    sourceAudioCodec?: string;
    /** Source audio channel count (2, 6, 8) */
    sourceAudioChannels?: number;
    /** Source video details (JSONB) */
    sourceVideoDetails?: SourceVideoDetails;
    /** Source audio details (JSONB) */
    sourceAudioDetails?: SourceAudioDetails;

    // ============ Stream Output Details (Delivered to client) ============
    /** Stream video codec after transcode */
    streamVideoCodec?: string;
    /** Stream audio codec after transcode */
    streamAudioCodec?: string;
    /** Stream video details (JSONB) */
    streamVideoDetails?: StreamVideoDetails;
    /** Stream audio details (JSONB) */
    streamAudioDetails?: StreamAudioDetails;

    // ============ Transcode & Subtitle Info ============
    /** Transcode processing details (JSONB) */
    transcodeInfo?: TranscodeInfo;
    /** Subtitle stream details (JSONB) */
    subtitleInfo?: SubtitleInfo;
  };

  /**
   * Jellyfin-specific: When the current pause started (from API).
   * More accurate than tracking pause transitions via polling.
   * Plex doesn't provide this field.
   */
  lastPausedDate?: Date;

  /**
   * Plex Session.id - required for termination API (different from sessionKey!)
   * For Jellyfin/Emby, this is the same as sessionKey so can be omitted.
   */
  plexSessionId?: string;
}

// ============================================================================
// User Types
// ============================================================================

/**
 * Unified user representation across media servers
 */
export interface MediaUser {
  /** User ID from media server */
  id: string;
  /** Display name */
  username: string;
  /** Email address (may be empty for local accounts) */
  email?: string;
  /** Avatar/profile image URL */
  thumb?: string;
  /** Whether user is an administrator */
  isAdmin: boolean;
  /** Whether user account is disabled */
  isDisabled?: boolean;
  /** Plex-specific: whether this is a home/managed user */
  isHomeUser?: boolean;
  /** Library IDs this user has access to (empty = all libraries) */
  sharedLibraries?: string[];
  /** Last login timestamp */
  lastLoginAt?: Date;
  /** Last activity timestamp */
  lastActivityAt?: Date;
  /** When user joined/was added to media server (Plex only - from createdAt/joinedAt) */
  joinedAt?: Date;
}

// ============================================================================
// Library Types
// ============================================================================

/**
 * Unified library representation across media servers
 */
export interface MediaLibrary {
  /** Library identifier */
  id: string;
  /** Library display name */
  name: string;
  /** Library type (movies, shows, music, photos, etc.) */
  type: string;
  /** Plex: agent identifier */
  agent?: string;
  /** Plex: scanner identifier */
  scanner?: string;
  /** Jellyfin: file system locations */
  locations?: string[];
}

// ============================================================================
// Library Item Types
// ============================================================================

/**
 * Unified library item representation across media servers
 *
 * Used for library scanning and snapshot generation. Contains both
 * metadata and quality information needed for library statistics.
 */
export interface MediaLibraryItem {
  // === Core Identification ===

  /** Server-specific ID (Plex ratingKey, Jellyfin/Emby Id) */
  ratingKey: string;

  /** Item title */
  title: string;

  /** Content type */
  mediaType: 'movie' | 'show' | 'season' | 'episode' | 'artist' | 'album' | 'track';

  /** Release year (optional) */
  year?: number;

  /** When item was added to library */
  addedAt: Date;

  // === Quality Fields (all optional) ===

  /** Video resolution string ('4k', '1080p', '720p', 'sd') */
  videoResolution?: string;

  /** Video codec (HEVC, H264, VP9, AV1, etc.) */
  videoCodec?: string;

  /** Audio codec (TrueHD, DTS-HD MA, AAC, FLAC, etc.) */
  audioCodec?: string;

  /** Audio channel count (2, 6, 8) */
  audioChannels?: number;

  /** File size in bytes */
  fileSize?: number;

  /** Container format (mkv, mp4, avi, etc.) */
  container?: string;

  // === External ID Fields (filled by Phase 3 enrichment or from server data) ===

  /** IMDB ID (e.g., "tt1234567") */
  imdbId?: string;

  /** TMDB numeric ID */
  tmdbId?: number;

  /** TVDB numeric ID */
  tvdbId?: number;

  // === Hierarchy Fields (for episodes and tracks) ===
  // Uses Plex-style naming: grandparent (show/artist), parent (season/album)
  // For episodes: grandparent=show, parent=season
  // For tracks: grandparent=artist, parent=album

  /** Grandparent title (show name for episodes, artist name for tracks) */
  grandparentTitle?: string;

  /** Grandparent rating key (show ID for episodes, artist ID for tracks) */
  grandparentRatingKey?: string;

  /** Parent title (season name for episodes, album name for tracks) */
  parentTitle?: string;

  /** Parent rating key (season ID for episodes, album ID for tracks) */
  parentRatingKey?: string;

  /** Parent index (season number for episodes, unused for tracks) */
  parentIndex?: number;

  /** Item index (episode number for episodes, track number for tracks) */
  itemIndex?: number;

  // === Debug Field ===

  /** File path (debug only - NEVER use for matching across servers) */
  filePath?: string;
}

// ============================================================================
// Watch History Types
// ============================================================================

/**
 * Unified watch history item representation
 */
export interface MediaWatchHistoryItem {
  /** Media item identifier */
  mediaId: string;
  /** Item title */
  title: string;
  /** Media type */
  type: 'movie' | 'episode' | 'track' | 'live' | 'photo' | 'trailer' | 'unknown';
  /** When item was last watched (Unix timestamp or ISO string) */
  watchedAt: number | string;
  /** User ID who watched (if available) */
  userId?: string;
  /** Episode-specific metadata */
  episode?: {
    showTitle: string;
    seasonNumber?: number;
    episodeNumber?: number;
  };
  /** Play count (Jellyfin-specific) */
  playCount?: number;
}

// ============================================================================
// Media Server Client Interface
// ============================================================================

/**
 * Configuration for creating a media server client
 */
export interface MediaServerConfig {
  /** Server URL (without trailing slash) */
  url: string;
  /** Authentication token (encrypted) */
  token: string;
  /** Server ID (for logging and reference) */
  id?: string;
  /** Server name (for logging) */
  name?: string;
}

/**
 * Common interface for media server clients
 *
 * Both PlexClient and JellyfinClient implement this interface,
 * enabling polymorphic usage in the poller, sync, and other services.
 *
 * @example
 * const client = createMediaServerClient(server.type, { url, token });
 * const sessions = await client.getSessions();
 * const users = await client.getUsers();
 */
export interface IMediaServerClient {
  /** The type of media server this client connects to */
  readonly serverType: ServerType;

  /**
   * Get all active playback sessions
   */
  getSessions(): Promise<MediaSession[]>;

  /**
   * Get all users with access to this server
   */
  getUsers(): Promise<MediaUser[]>;

  /**
   * Get all libraries on this server
   */
  getLibraries(): Promise<MediaLibrary[]>;

  /**
   * Test connection to the server
   * @returns true if connection successful, false otherwise
   */
  testConnection(): Promise<boolean>;

  /**
   * Terminate a playback session
   *
   * @param sessionId - The session ID to terminate (use terminationId from MediaSession)
   * @param reason - Optional message to display to user before termination
   * @returns true if successful
   * @throws Error if termination fails
   */
  terminateSession(sessionId: string, reason?: string): Promise<boolean>;

  /**
   * Get all items in a library with pagination support
   *
   * Used for library scanning and snapshot generation. Returns items
   * with quality metadata and external IDs when available.
   *
   * @param libraryId - The library identifier
   * @param options - Pagination options
   * @returns Promise with items array and total count for pagination
   */
  getLibraryItems(
    libraryId: string,
    options?: {
      offset?: number;
      limit?: number;
    }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }>;

  /**
   * Get all leaf items (episodes) from a library with pagination support
   *
   * For TV show libraries, returns all episodes across all shows.
   * Optional - only implemented by servers that support hierarchical libraries.
   *
   * @param libraryId - The library identifier
   * @param options - Pagination options
   * @returns Promise with episode items and total count, or undefined if not supported
   */
  getLibraryLeaves?(
    libraryId: string,
    options?: {
      offset?: number;
      limit?: number;
    }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }>;
}

/**
 * Extended client interface with optional watch history support
 * Not all servers support watch history in the same way
 */
export interface IMediaServerClientWithHistory extends IMediaServerClient {
  /**
   * Get watch history
   * @param options - Optional filters for history retrieval
   */
  getWatchHistory(options?: { userId?: string; limit?: number }): Promise<MediaWatchHistoryItem[]>;
}

// ============================================================================
// Factory Types
// ============================================================================

/**
 * Options for creating a media server client
 */
export interface CreateClientOptions extends MediaServerConfig {
  /** Server type */
  type: ServerType;
}
