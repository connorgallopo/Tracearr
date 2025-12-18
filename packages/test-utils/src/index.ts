/**
 * @tracearr/test-utils
 *
 * Shared test utilities for Tracearr packages.
 * Provides database setup, factories, mocks, matchers, and helpers.
 *
 * @module @tracearr/test-utils
 */

// Database utilities
export {
  getTestPool,
  getTestDb,
  executeRawSql,
  closeTestPool,
  setupTestDb,
  isTestDbReady,
  waitForTestDb,
  resetTestDb,
  teardownTestDb,
  truncateTables,
  seedBasicOwner,
  seedMultipleUsers,
  seedUserWithSessions,
  seedViolationScenario,
  seedMobilePairing,
  type SeedResult,
} from './db/index.js';

// Test factories
export {
  // User factories
  buildUser,
  createTestUser,
  createTestOwner,
  createTestAdmin,
  createTestMember,
  createTestUsers,
  resetUserCounter,
  type UserData,
  type CreatedUser,
  // Server factories
  buildServer,
  createTestServer,
  createTestPlexServer,
  createTestJellyfinServer,
  createTestEmbyServer,
  createTestServers,
  resetServerCounter,
  type ServerData,
  type CreatedServer,
  type ServerType,
  // ServerUser factories
  buildServerUser,
  createTestServerUser,
  createTestServerAdmin,
  resetServerUserCounter,
  type ServerUserData,
  type CreatedServerUser,
  // Session factories
  buildSession,
  createTestSession,
  createActiveSession,
  createPausedSession,
  createStoppedSession,
  createEpisodeSession,
  createConcurrentSessions,
  resetSessionCounter,
  type SessionData,
  type CreatedSession,
  type SessionState,
  type MediaType,
  // Rule factories
  buildRule,
  createTestRule,
  createImpossibleTravelRule,
  createSimultaneousLocationsRule,
  createDeviceVelocityRule,
  createConcurrentStreamsRule,
  createGeoRestrictionRule,
  resetRuleCounter,
  type RuleData,
  type CreatedRule,
  type RuleType,
  type RuleParams,
  type ImpossibleTravelParams,
  type SimultaneousLocationsParams,
  type DeviceVelocityParams,
  type ConcurrentStreamsParams,
  type GeoRestrictionParams,
  // Violation factories
  buildViolation,
  createTestViolation,
  createLowViolation,
  createWarningViolation,
  createHighViolation,
  createAcknowledgedViolation,
  createImpossibleTravelViolation,
  createConcurrentStreamsViolation,
  resetViolationCounter,
  type ViolationData,
  type CreatedViolation,
  type ViolationSeverity,
  // Reset all
  resetAllFactoryCounters,
} from './factories/index.js';

// Mock utilities
export {
  // Redis mocks
  getMockRedis,
  createMockRedis,
  resetMockRedis,
  createSimpleMockRedis,
  type SimpleMockRedis,
  // Media server mocks
  createMockMediaServerClient,
  createMockPlexClient,
  createMockJellyfinClient,
  createMockEmbyClient,
  buildMockSession,
  buildMockUser,
  buildMockLibrary,
  resetMockMediaCounters,
  type IMediaServerClient,
  type MediaSession,
  type MediaUser,
  type MediaLibrary,
  type MockMediaServerClient,
  type MockMediaServerOptions,
  // Expo Push mocks
  createMockExpoPushClient,
  createMockPushNotificationService,
  resetExpoPushCounter,
  type PushTicket,
  type PushReceipt,
  type PushMessage,
  type SentNotification,
  type MockExpoPushClient,
  type MockExpoPushOptions,
  type MockPushNotificationService,
  // WebSocket mocks
  createMockSocketClient,
  createMockSocketServer,
  createMockGetIO,
  createMockBroadcasters,
  resetSocketCounter,
  waitForEvent,
  collectEvents,
  type SocketEvent,
  type MockSocketClient,
  type MockSocketServer,
  type TracearrServerEvent,
  type TracearrClientEvent,
  // Reset all mocks
  resetAllMocks,
} from './mocks/index.js';

// Custom matchers
export {
  installMatchers,
  type HTTPResponse,
  type ValidationErrorResponse,
} from './matchers/index.js';

// Helper utilities
export {
  // Auth helpers
  generateTestToken,
  generateExpiredToken,
  generateInvalidToken,
  decodeToken,
  verifyTestToken,
  generateOwnerToken,
  generateAdminToken,
  generateMemberToken,
  authHeaders,
  ownerAuthHeaders,
  adminAuthHeaders,
  memberAuthHeaders,
  getTestJwtSecret,
  generateMobilePairingToken,
  generateQRPairingPayload,
  type TestTokenPayload,
  type GenerateTokenOptions,
  // Time helpers
  relativeDate,
  time,
  timestamp,
  todayAt,
  dateAt,
  duration,
  parseDuration,
  formatDuration,
  dateDiff,
  isWithinRange,
  dateSequence,
  mockTime,
  // Wait helpers
  wait,
  nextTick,
  nextLoop,
  flushPromises,
  waitFor,
  waitForValue,
  waitForResult,
  waitForLength,
  waitForNoThrow,
  retry,
  withTimeout,
  concurrent,
  measureTime,
  assertFastEnough,
  type WaitForOptions,
  type RetryOptions,
} from './helpers/index.js';
