// Stats hooks
export {
  useDashboardStats,
  useMyStats,
  useMyTopTitles,
  usePlaysStats,
  useLocationStats,
  useLocationPeople,
  usePlaysByDayOfWeek,
  usePlaysByHourOfDay,
  usePlatformStats,
  useQualityStats,
  usePeople,
  useTopContent,
  useConcurrentStats,
  useEngagementStats,
  useShowStats,
  // Device compatibility
  useDeviceCompatibility,
  useDeviceCompatibilityMatrix,
  useDeviceHealth,
  useTranscodeHotspots,
  useDownloadsStats,
  // Bandwidth stats
  useBandwidthDaily,
  useBandwidthSummary,
  type LocationStatsFilters,
  type StatsTimeRange,
  type EngagementStatsOptions,
  type ShowStatsOptions,
} from './useStats';

// Session hooks
export {
  useSessions,
  useActiveSessions,
  useOthersActive,
  useSession,
  useBulkDeleteSessions,
} from './useSessions';
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
  useUserRangeStats,
  useUserSessions,
  useUserDownloads,
  useUpdateUser,
  useUpdateUserIdentity,
  useUpdateUserAccess,
  useUserLocations,
  useUserDevices,
  useUserTerminations,
  useBulkResetTrust,
  useMergeSuggestions,
  useDismissedMergeSuggestions,
  useDismissMergeSuggestion,
  useRestoreMergeSuggestion,
  useMergeUsers,
  useSplitServerUser,
  useOwnerLinks,
  useLinkOwnerAccount,
  useUnlinkOwnerAccount,
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
export { usePendingViolationsCount } from './usePendingViolationsCount';

// Server hooks
export {
  useServers,
  useCreateServer,
  useDeleteServer,
  useSyncServer,
  useUpdateServer,
  useSetServerHistorical,
  useServerLocations,
  useUpdateServerLocations,
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

// Request hooks
export {
  REQUESTS_KEY,
  useMediaRequests,
  useUserRequests,
  useMyRequests,
  useRequestsAnalytics,
  useRequestsConfigured,
  useRequestsUnplayed,
  useRequestServices,
  useTestRequestService,
  useCreateRequestService,
  useUpdateRequestService,
  useDeleteRequestService,
  useSyncRequestService,
} from './useRequests';

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

// What's new hooks
export { WHATS_NEW_KEY, useWhatsNew, useDismissWhatsNew } from './useWhatsNew';

// Library hooks
export {
  useLibraryStats,
  useLibraryGrowth,
  useLibraryQuality,
  useLibraryStorageScoped,
  useLibraryDuplicates,
  useLibraryStale,
  useLibraryWatch,
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
  useGenreDetail,
  useCatalogCodecs,
  useLibraries,
  useMediaDetail,
  useMediaStats,
  useMediaWatchers,
  useSeasonHeat,
  useMediaChildren,
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
export { useAlbumDetail } from './useAlbumDetail';
