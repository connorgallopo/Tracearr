/**
 * Shared Test Fixtures for Jellyfin/Emby Parser Tests
 *
 * Factory functions for creating test data that can be reused across
 * both Jellyfin and Emby parser tests. These fixtures reduce duplication
 * while allowing platform-specific customization.
 */

// ============================================================================
// Base Session Fixtures
// ============================================================================

export interface RawSessionOptions {
  id?: string;
  userId?: string;
  userName?: string;
  userPrimaryImageTag?: string;
  deviceName?: string;
  deviceId?: string;
  client?: string;
  deviceType?: string;
  remoteEndPoint?: string;
  nowPlayingItem?: Record<string, unknown>;
  playState?: Record<string, unknown>;
  transcodingInfo?: Record<string, unknown>;
}

/**
 * Create a base raw session object for testing
 */
export function createRawSession(options: RawSessionOptions = {}): Record<string, unknown> {
  return {
    Id: options.id ?? 'session-123',
    UserId: options.userId ?? 'user-456',
    UserName: options.userName ?? 'TestUser',
    UserPrimaryImageTag: options.userPrimaryImageTag,
    DeviceName: options.deviceName ?? 'Test Device',
    DeviceId: options.deviceId ?? 'device-uuid-789',
    Client: options.client ?? 'Test Client',
    DeviceType: options.deviceType,
    RemoteEndPoint: options.remoteEndPoint ?? '192.168.1.100',
    NowPlayingItem: options.nowPlayingItem,
    PlayState: options.playState ?? {},
    TranscodingInfo: options.transcodingInfo,
  };
}

// ============================================================================
// Movie Session Fixtures
// ============================================================================

export interface MovieItemOptions {
  id?: string;
  name?: string;
  runTimeTicks?: number;
  productionYear?: number;
  primaryImageTag?: string;
}

/**
 * Create a raw movie NowPlayingItem
 */
export function createMovieItem(options: MovieItemOptions = {}): Record<string, unknown> {
  return {
    Id: options.id ?? 'movie-abc',
    Name: options.name ?? 'Test Movie',
    Type: 'Movie',
    RunTimeTicks: options.runTimeTicks ?? 90000000000, // 150 minutes
    ProductionYear: options.productionYear ?? 2024,
    ImageTags: options.primaryImageTag ? { Primary: options.primaryImageTag } : undefined,
  };
}

/**
 * Create a complete movie session for testing
 */
export function createMovieSession(
  client: string = 'Jellyfin Web',
  overrides: Partial<RawSessionOptions> = {}
): Record<string, unknown> {
  return createRawSession({
    client,
    nowPlayingItem: createMovieItem(),
    playState: {
      PositionTicks: 36000000000, // 60 minutes
      IsPaused: false,
    },
    ...overrides,
  });
}

// ============================================================================
// Episode Session Fixtures
// ============================================================================

export interface EpisodeItemOptions {
  id?: string;
  name?: string;
  runTimeTicks?: number;
  seriesName?: string;
  seriesId?: string;
  seriesPrimaryImageTag?: string;
  parentIndexNumber?: number;
  indexNumber?: number;
  seasonName?: string;
}

/**
 * Create a raw episode NowPlayingItem
 */
export function createEpisodeItem(options: EpisodeItemOptions = {}): Record<string, unknown> {
  return {
    Id: options.id ?? 'episode-abc',
    Name: options.name ?? 'Pilot',
    Type: 'Episode',
    RunTimeTicks: options.runTimeTicks ?? 36000000000, // 60 minutes
    SeriesName: options.seriesName ?? 'Test Show',
    SeriesId: options.seriesId ?? 'series-123',
    SeriesPrimaryImageTag: options.seriesPrimaryImageTag ?? 'series-poster-tag',
    ParentIndexNumber: options.parentIndexNumber ?? 1,
    IndexNumber: options.indexNumber ?? 1,
    SeasonName: options.seasonName ?? 'Season 1',
  };
}

/**
 * Create a complete episode session for testing
 */
export function createEpisodeSession(
  client: string = 'Jellyfin Web',
  overrides: Partial<RawSessionOptions> = {}
): Record<string, unknown> {
  return createRawSession({
    client,
    nowPlayingItem: createEpisodeItem(),
    playState: {
      PositionTicks: 18000000000, // 30 minutes
      IsPaused: true,
    },
    ...overrides,
  });
}

// ============================================================================
// Live TV Session Fixtures
// ============================================================================

export interface LiveTvItemOptions {
  id?: string;
  name?: string;
  type?: 'LiveTvChannel' | 'TvChannel';
  channelId?: string;
  channelName?: string;
  channelNumber?: string;
}

/**
 * Create a raw Live TV NowPlayingItem
 */
export function createLiveTvItem(options: LiveTvItemOptions = {}): Record<string, unknown> {
  return {
    Id: options.id ?? 'channel-abc',
    Name: options.name ?? 'CNN Live',
    Type: options.type ?? 'LiveTvChannel',
    ChannelId: options.channelId ?? options.id ?? 'channel-abc',
    ChannelName: options.channelName ?? 'CNN',
    ChannelNumber: options.channelNumber ?? '202',
  };
}

/**
 * Create a complete Live TV session for testing
 */
export function createLiveTvSession(
  client: string = 'Jellyfin Android TV',
  overrides: Partial<RawSessionOptions & LiveTvItemOptions> = {}
): Record<string, unknown> {
  const { id, name, type, channelId, channelName, channelNumber, ...sessionOverrides } = overrides;
  return createRawSession({
    client,
    nowPlayingItem: createLiveTvItem({ id, name, type, channelId, channelName, channelNumber }),
    playState: {
      IsPaused: false,
    },
    ...sessionOverrides,
  });
}

// ============================================================================
// Music Track Session Fixtures
// ============================================================================

export interface MusicTrackItemOptions {
  id?: string;
  name?: string;
  runTimeTicks?: number;
  albumArtist?: string;
  artists?: string[];
  album?: string;
  indexNumber?: number;
  parentIndexNumber?: number;
  albumId?: string;
  albumPrimaryImageTag?: string;
}

/**
 * Create a raw music track NowPlayingItem
 */
export function createMusicTrackItem(options: MusicTrackItemOptions = {}): Record<string, unknown> {
  return {
    Id: options.id ?? 'track-123',
    Name: options.name ?? 'Test Track',
    Type: 'Audio',
    RunTimeTicks: options.runTimeTicks ?? 3000000000, // 5 minutes
    AlbumArtist: options.albumArtist ?? 'Test Artist',
    Artists: options.artists,
    Album: options.album ?? 'Test Album',
    IndexNumber: options.indexNumber ?? 1,
    ParentIndexNumber: options.parentIndexNumber ?? 1,
    AlbumId: options.albumId ?? 'album-123',
    AlbumPrimaryImageTag: options.albumPrimaryImageTag ?? 'album-art-tag',
  };
}

/**
 * Create a complete music track session for testing
 */
export function createMusicSession(
  client: string = 'Jellyfin Mobile',
  overrides: Partial<RawSessionOptions & MusicTrackItemOptions> = {}
): Record<string, unknown> {
  const {
    id,
    name,
    runTimeTicks,
    albumArtist,
    artists,
    album,
    indexNumber,
    parentIndexNumber,
    albumId,
    albumPrimaryImageTag,
    ...sessionOverrides
  } = overrides;

  return createRawSession({
    client,
    nowPlayingItem: createMusicTrackItem({
      id,
      name,
      runTimeTicks,
      albumArtist,
      artists,
      album,
      indexNumber,
      parentIndexNumber,
      albumId,
      albumPrimaryImageTag,
    }),
    playState: {
      PositionTicks: 600000000, // 1 minute
      IsPaused: false,
    },
    ...sessionOverrides,
  });
}

// ============================================================================
// User Fixtures
// ============================================================================

export interface RawUserOptions {
  id?: string;
  name?: string;
  serverId?: string;
  hasPassword?: boolean;
  hasConfiguredPassword?: boolean;
  enableAutoLogin?: boolean;
  lastLoginDate?: string;
  lastActivityDate?: string;
  primaryImageTag?: string;
  policy?: Record<string, unknown>;
}

/**
 * Create a raw user object for testing
 */
export function createRawUser(options: RawUserOptions = {}): Record<string, unknown> {
  return {
    Id: options.id ?? 'user-123',
    Name: options.name ?? 'TestUser',
    ServerId: options.serverId ?? 'server-abc',
    HasPassword: options.hasPassword ?? true,
    HasConfiguredPassword: options.hasConfiguredPassword ?? true,
    EnableAutoLogin: options.enableAutoLogin ?? false,
    LastLoginDate: options.lastLoginDate ?? '2024-01-15T10:30:00.000Z',
    LastActivityDate: options.lastActivityDate ?? '2024-01-15T12:00:00.000Z',
    PrimaryImageTag: options.primaryImageTag,
    Policy: options.policy ?? {
      IsAdministrator: false,
      IsDisabled: false,
    },
  };
}

// ============================================================================
// Library Fixtures
// ============================================================================

export interface RawLibraryOptions {
  id?: string;
  name?: string;
  collectionType?: string;
  serverId?: string;
  locations?: string[];
}

/**
 * Create a raw library object for testing
 */
export function createRawLibrary(options: RawLibraryOptions = {}): Record<string, unknown> {
  return {
    Id: options.id ?? 'lib-123',
    Name: options.name ?? 'Movies',
    CollectionType: options.collectionType ?? 'movies',
    ServerId: options.serverId ?? 'server-abc',
    Locations: options.locations ?? ['/media/movies'],
  };
}

// ============================================================================
// Watch History Fixtures
// ============================================================================

export interface RawWatchHistoryItemOptions {
  id?: string;
  name?: string;
  type?: string;
  lastPlayedDate?: string;
  playCount?: number;
  seriesName?: string;
  parentIndexNumber?: number;
  indexNumber?: number;
}

/**
 * Create a raw watch history item for testing
 */
export function createRawWatchHistoryItem(
  options: RawWatchHistoryItemOptions = {}
): Record<string, unknown> {
  return {
    Id: options.id ?? 'item-123',
    Name: options.name ?? 'Test Content',
    Type: options.type ?? 'Movie',
    UserData: {
      LastPlayedDate: options.lastPlayedDate ?? '2024-01-15T10:30:00.000Z',
      PlayCount: options.playCount ?? 1,
    },
    SeriesName: options.seriesName,
    ParentIndexNumber: options.parentIndexNumber,
    IndexNumber: options.indexNumber,
  };
}

// ============================================================================
// Activity Log Fixtures
// ============================================================================

export interface RawActivityLogOptions {
  id?: number;
  name?: string;
  type?: string;
  date?: string;
  userId?: string;
  itemId?: string;
  severity?: string;
}

/**
 * Create a raw activity log item for testing
 */
export function createRawActivityLog(options: RawActivityLogOptions = {}): Record<string, unknown> {
  return {
    Id: options.id ?? 1,
    Name: options.name ?? 'Test Activity',
    Type: options.type ?? 'SessionEnded',
    Date: options.date ?? '2024-01-15T10:30:00.000Z',
    UserId: options.userId ?? 'user-123',
    ItemId: options.itemId,
    Severity: options.severity ?? 'Information',
  };
}

// ============================================================================
// Auth Response Fixtures
// ============================================================================

export interface RawAuthResponseOptions {
  user?: Record<string, unknown>;
  sessionInfo?: Record<string, unknown>;
  accessToken?: string;
  serverId?: string;
}

/**
 * Create a raw auth response for testing
 */
export function createRawAuthResponse(
  options: RawAuthResponseOptions = {}
): Record<string, unknown> {
  return {
    User: options.user ?? createRawUser(),
    SessionInfo: options.sessionInfo ?? {
      Id: 'session-abc',
      UserId: 'user-123',
      DeviceId: 'device-xyz',
    },
    AccessToken: options.accessToken ?? 'test-access-token',
    ServerId: options.serverId ?? 'server-abc',
  };
}
