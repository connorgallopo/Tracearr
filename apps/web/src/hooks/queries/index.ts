// Stats hooks
export {
  useDashboardStats,
  usePlaysStats,
  useUserStats,
  useLocationStats,
  usePlaysByDayOfWeek,
  usePlaysByHourOfDay,
  usePlatformStats,
  useQualityStats,
  useTopUsers,
  useTopContent,
  useConcurrentStats,
  useEngagementStats,
  useShowStats,
  // Device compatibility
  useDeviceCompatibility,
  useDeviceCompatibilityMatrix,
  useDeviceHealth,
  useTranscodeHotspots,
  useTopTranscodingUsers,
  // Bandwidth stats
  useBandwidthDaily,
  useBandwidthTopUsers,
  useBandwidthSummary,
  type LocationStatsFilters,
  type StatsTimeRange,
  type EngagementStatsOptions,
  type ShowStatsOptions,
} from './useStats';

// Session hooks
export { useSessions, useActiveSessions, useSession, useBulkDeleteSessions } from './useSessions';
export { useTerminateSession } from './useTerminateSession';

// History hooks (advanced session queries with infinite scroll)
export {
  useHistorySessions,
  useHistoryAggregates,
  useFilterOptions,
  type HistoryFilters,
  type AggregateFilters,
} from './useHistory';

// User hooks
export {
  useUsers,
  useUser,
  useUserFull,
  useUserSessions,
  useUpdateUser,
  useUpdateUserIdentity,
  useUserLocations,
  useUserDevices,
  useUserTerminations,
  useBulkResetTrust,
} from './useUsers';

// Rule hooks
export {
  useRules,
  useCreateRule,
  useUpdateRule,
  useDeleteRule,
  useToggleRule,
  useBulkToggleRules,
  useBulkDeleteRules,
} from './useRules';

// Violation hooks
export {
  useViolations,
  useAcknowledgeViolation,
  useDismissViolation,
  useBulkAcknowledgeViolations,
  useBulkDismissViolations,
} from './useViolations';

// Server hooks
export {
  useServers,
  useCreateServer,
  useDeleteServer,
  useSyncServer,
  useUpdateServerUrl,
  useServerStatistics,
  usePlexServerConnections,
  useReorderServers,
} from './useServers';

// Settings hooks
export { useSettings, useUpdateSettings, useApiKey, useRegenerateApiKey } from './useSettings';

// Channel Routing hooks
export { useChannelRouting, useUpdateChannelRouting } from './useChannelRouting';

// Mobile hooks
export {
  useMobileConfig,
  useEnableMobile,
  useDisableMobile,
  useGeneratePairToken,
  useRevokeSession,
  useRevokeMobileSessions,
} from './useMobile';

// Version hooks
export { useVersion, useForceVersionCheck } from './useVersion';

// Library hooks
export {
  useLibraryStats,
  useLibraryGrowth,
  useLibraryQuality,
  useLibraryStorage,
  useLibraryDuplicates,
  useLibraryStale,
  useLibraryWatch,
  useLibraryCompletion,
  useLibraryPatterns,
  useLibraryRoi,
  useTopMovies,
  useTopShows,
  useLibraryCodecs,
  useLibraryResolution,
} from './useLibrary';
