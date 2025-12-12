/**
 * @tracearr/shared - Shared types, schemas, and constants
 */

// Type exports
export type {
  // Server
  ServerType,
  Server,
  // User
  User,
  ServerUser,
  ServerUserWithIdentity,
  ServerUserDetail,
  ServerUserFullDetail,
  ViolationSummary,
  UserRole,
  AuthUser,
  UserLocation,
  UserDevice,
  // Session
  SessionState,
  MediaType,
  Session,
  SessionWithDetails,
  ActiveSession,
  // Rule
  RuleType,
  ImpossibleTravelParams,
  SimultaneousLocationsParams,
  DeviceVelocityParams,
  ConcurrentStreamsParams,
  GeoRestrictionParams,
  RuleParams,
  Rule,
  // Violation
  ViolationSeverity,
  Violation,
  ViolationWithDetails,
  ViolationSessionInfo,
  // Stats
  DashboardStats,
  PlayStats,
  UserStats,
  LocationStats,
  LocationStatsSummary,
  LocationStatsResponse,
  LibraryStats,
  DayOfWeekStats,
  HourOfDayStats,
  QualityStats,
  TopUserStats,
  TopContentStats,
  PlatformStats,
  // Server resource stats
  ServerResourceDataPoint,
  ServerResourceStats,
  // Settings
  Settings,
  WebhookFormat,
  // Tautulli import
  TautulliImportProgress,
  TautulliImportResult,
  // WebSocket
  ServerToClientEvents,
  ClientToServerEvents,
  // API
  PaginatedResponse,
  ApiError,
  // Mobile
  MobileToken,
  MobileSession,
  MobileConfig,
  MobilePairRequest,
  MobilePairResponse,
  MobilePairTokenResponse,
  MobileQRPayload,
  NotificationEventType,
  NotificationPreferences,
  RateLimitStatus,
  NotificationPreferencesWithStatus,
  NotificationChannel,
  NotificationChannelRouting,
  EncryptedPushPayload,
  PushNotificationPayload,
  // SSE (Server-Sent Events)
  SSEConnectionState,
  PlexSSENotification,
  PlexPlaySessionNotification,
  PlexActivityNotification,
  PlexStatusNotification,
  PlexTranscodeNotification,
  SSEConnectionStatus,
  // Termination logs
  TerminationTrigger,
  TerminationLogWithDetails,
  // Plex server discovery
  PlexDiscoveredConnection,
  PlexDiscoveredServer,
  PlexAvailableServersResponse,
} from './types.js';

// Schema exports
export {
  // Common
  uuidSchema,
  paginationSchema,
  // Auth
  loginSchema,
  callbackSchema,
  // Server
  createServerSchema,
  serverIdParamSchema,
  // User
  updateUserSchema,
  userIdParamSchema,
  // Session
  sessionQuerySchema,
  sessionIdParamSchema,
  terminateSessionBodySchema,
  // Rule
  impossibleTravelParamsSchema,
  simultaneousLocationsParamsSchema,
  deviceVelocityParamsSchema,
  concurrentStreamsParamsSchema,
  geoRestrictionParamsSchema,
  ruleParamsSchema,
  createRuleSchema,
  updateRuleSchema,
  ruleIdParamSchema,
  // Violation
  violationQuerySchema,
  violationIdParamSchema,
  // Stats
  serverIdFilterSchema,
  statsQuerySchema,
  locationStatsQuerySchema,
  // Settings
  updateSettingsSchema,
  // Tautulli import
  tautulliImportSchema,
} from './schemas.js';

// Schema input type exports
export type {
  LoginInput,
  CallbackInput,
  CreateServerInput,
  UpdateUserInput,
  SessionQueryInput,
  CreateRuleInput,
  UpdateRuleInput,
  ViolationQueryInput,
  ServerIdFilterInput,
  StatsQueryInput,
  LocationStatsQueryInput,
  UpdateSettingsInput,
  TautulliImportInput,
} from './schemas.js';

// Constant exports
export {
  RULE_DEFAULTS,
  RULE_DISPLAY_NAMES,
  SEVERITY_LEVELS,
  getSeverityPriority,
  type SeverityPriority,
  WS_EVENTS,
  REDIS_KEYS,
  CACHE_TTL,
  NOTIFICATION_EVENTS,
  API_VERSION,
  API_BASE_PATH,
  JWT_CONFIG,
  POLLING_INTERVALS,
  PAGINATION,
  GEOIP_CONFIG,
  TIME_MS,
  SESSION_LIMITS,
  SERVER_STATS_CONFIG,
  // SSE
  SSE_CONFIG,
  PLEX_SSE_EVENTS,
  SSE_STATE,
} from './constants.js';

// Role helper exports
export {
  ROLE_PERMISSIONS,
  canLogin,
  hasMinRole,
  isOwner,
  isActive,
} from './types.js';
