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
export { useSessions, useActiveSessions, useSession } from './useSessions';
export { useTerminateSession } from './useTerminateSession';

// History hooks (advanced session queries with infinite scroll)
export { useHistorySessions, useFilterOptions, type HistoryFilters } from './useHistory';

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
} from './useUsers';

// Rule hooks
export { useRules, useCreateRule, useUpdateRule, useDeleteRule, useToggleRule } from './useRules';

// Violation hooks
export { useViolations, useAcknowledgeViolation, useDismissViolation } from './useViolations';

// Server hooks
export {
  useServers,
  useCreateServer,
  useDeleteServer,
  useSyncServer,
  useUpdateServerUrl,
  useServerStatistics,
  usePlexServerConnections,
} from './useServers';

// Settings hooks
export { useSettings, useUpdateSettings } from './useSettings';

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
