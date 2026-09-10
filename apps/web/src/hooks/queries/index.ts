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
  useMergeSuggestions,
  useMergeUsers,
  useSplitServerUser,
} from './useUsers';

// Automation hooks
export {
  AUTOMATIONS_KEY,
  useAutomation,
  useAutomations,
  useBulkDeleteAutomations,
  useBulkToggleAutomations,
  useCreateAutomation,
  useDeleteAutomation,
  useDetachAutomation,
  useRebindAutomation,
  useToggleAutomation,
  useUpdateAutomation,
  useUpgradeAutomation,
} from './useAutomations';

// Automation template hooks
export {
  TEMPLATES_KEY,
  useImportTemplate,
  useInstantiateTemplate,
  usePreviewTemplate,
  useTemplate,
  useTemplates,
  useTemplateVersion,
} from './useTemplates';

// Automation run hooks
export { RUNS_KEY, useAutomationEvaluations, useAutomationRuns, useRun } from './useRuns';

// Violation hooks
export {
  useViolations,
  useViolation,
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
  useUpdateServer,
  useServerLiveStats,
  useMultiServerLiveStats,
  usePlexServerConnections,
  useReorderServers,
} from './useServers';

// Settings hooks
export {
  useSettings,
  useUpdateSettings,
  useApiKey,
  useRegenerateApiKey,
  useImageCacheStatus,
} from './useSettings';

// Destination hooks
export {
  useDestinations,
  useCreateDestination,
  useUpdateDestination,
  useDeleteDestination,
  useTestDestination,
  useTestUnsavedDestination,
} from './useDestinations';

// Newsletter hooks
export {
  NEWSLETTERS_KEY,
  newsletterKeys,
  useNewsletters,
  useNewsletter,
  useNewsletterRecipients,
  useNewsletterVariants,
  useNewsletterSends,
  useNewsletterSend,
  useCreateNewsletter,
  useUpdateNewsletter,
  useDeleteNewsletter,
  useDuplicateNewsletter,
  usePreviewNewsletter,
  usePreviewDraftNewsletter,
  useTestNewsletter,
  useSendNewsletter,
  useNewsletterSendHtml,
  useRetryFailedSend,
} from './useNewsletters';

// Email branding and suppression hooks
export {
  EMAIL_BRANDING_KEY,
  EMAIL_SUPPRESSIONS_KEY,
  useEmailBranding,
  useSaveEmailBranding,
  useEmailSuppressions,
  useAddSuppression,
  useRemoveSuppression,
} from './useEmail';

// Mobile hooks
export {
  useMobileConfig,
  useEnableMobile,
  useDisableMobile,
  useGeneratePairToken,
  useUpdateMobileSession,
  useRevokeSession,
  useRevokeMobileSessions,
} from './useMobile';

// Tailscale hooks
export {
  useTailscaleStatus,
  useTailscaleLogs,
  useEnableTailscale,
  useDisableTailscale,
  // useSetExitNode, // Exit node disabled - will come back with SOCKS proxy support
  useResetTailscale,
} from './useTailscale';

// Version hooks
export { useVersion, useForceVersionCheck } from './useVersion';

// Library hooks
export {
  useLibraryStats,
  useLibraryGrowth,
  useLibraryQuality,
  useLibraryStorage,
  useLibraryStorageScoped,
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
  useLibraryStatus,
  type LibraryStatusResponse,
} from './useLibrary';
export type { MultiServerQueryResult } from '@/hooks/useMultiServerQuery';

// Media browsing hooks
export {
  useCatalogWindow,
  useCatalogLetters,
  buildLetterOffsets,
  activeLetterForItem,
  activeLetterForRow,
  pageIndicesForRange,
  CATALOG_PAGE_SIZE,
  useShelves,
  useGenres,
  useLibraries,
  useMediaDetail,
  useMediaStats,
  useMediaWatchers,
  useSeasonHeat,
  useMediaPlatforms,
  useMediaHistory,
  findCachedMediaStub,
  stableSerialize,
  detailFromStub,
  type CatalogSort,
  type CatalogFilters,
  type LetterOffset,
  type MediaDetailStub,
  type MediaDetailData,
} from './useMediaBrowse';
