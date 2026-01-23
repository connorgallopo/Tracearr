/**
 * Watch Sync Service
 *
 * Core service for synchronizing watch status between media servers.
 * Implements the Jellyplex-watched style sync logic.
 */

import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { servers, serverUsers, watchSyncConfigs, watchSyncUserMappings } from '../../db/schema.js';
import type {
  WatchSyncConfig,
  WatchSyncUserMapping,
  WatchSyncProgress,
  WatchSyncResult,
  WatchSyncPreviewItem,
  WatchedItem,
  WatchSyncSkippedUser,
} from '@tracearr/shared';
import type { IMediaServerClientWithWatchSync } from '../mediaServer/types.js';
import { PlexClient } from '../mediaServer/plex/client.js';
import { JellyfinClient } from '../mediaServer/jellyfin/client.js';
import { EmbyClient } from '../mediaServer/emby/client.js';
import { buildMatchLookup, matchItemFast, shouldSync } from './matcher.js';

/**
 * Internal user mapping with server user details
 */
interface UserMappingWithDetails {
  sourceServerUserId: string;
  sourceExternalId: string;
  sourceUsername: string;
  sourcePlexServerToken?: string | null; // Plex-specific: user's server access token
  targetServerUserId: string;
  targetExternalId: string;
  targetUsername: string;
  targetPlexServerToken?: string | null; // Plex-specific: user's server access token
}

/**
 * Watch Sync Service
 *
 * Handles synchronization of watch status between media servers.
 */
export class WatchSyncService {
  /**
   * Get all watch sync configurations
   */
  async getConfigs(): Promise<WatchSyncConfig[]> {
    const result = await db.query.watchSyncConfigs.findMany({
      with: {
        sourceServer: true,
        targetServer: true,
      },
      orderBy: (configs, { asc }) => [asc(configs.createdAt)],
    });

    return result.map((r) => ({
      id: r.id,
      sourceServerId: r.sourceServerId,
      sourceServerName: r.sourceServer?.name,
      targetServerId: r.targetServerId,
      targetServerName: r.targetServer?.name,
      enabled: r.enabled,
      dryRun: r.dryRun,
      syncMovies: r.syncMovies,
      syncShows: r.syncShows,
      syncInProgress: r.syncInProgress,
      intervalMinutes: r.intervalMinutes,
      lastSyncAt: r.lastSyncAt,
      lastSyncResult: r.lastSyncResult,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Get a specific watch sync configuration
   */
  async getConfig(configId: string): Promise<WatchSyncConfig | null> {
    const result = await db.query.watchSyncConfigs.findFirst({
      where: eq(watchSyncConfigs.id, configId),
      with: {
        sourceServer: true,
        targetServer: true,
      },
    });

    if (!result) return null;

    return {
      id: result.id,
      sourceServerId: result.sourceServerId,
      sourceServerName: result.sourceServer?.name,
      targetServerId: result.targetServerId,
      targetServerName: result.targetServer?.name,
      enabled: result.enabled,
      dryRun: result.dryRun,
      syncMovies: result.syncMovies,
      syncShows: result.syncShows,
      syncInProgress: result.syncInProgress,
      intervalMinutes: result.intervalMinutes,
      lastSyncAt: result.lastSyncAt,
      lastSyncResult: result.lastSyncResult,
      createdAt: result.createdAt,
    };
  }

  /**
   * Create a new watch sync configuration
   */
  async createConfig(data: {
    sourceServerId: string;
    targetServerId: string;
    enabled?: boolean;
    dryRun?: boolean;
    syncMovies?: boolean;
    syncShows?: boolean;
    syncInProgress?: boolean;
    intervalMinutes?: number;
  }): Promise<WatchSyncConfig> {
    const [created] = await db
      .insert(watchSyncConfigs)
      .values({
        sourceServerId: data.sourceServerId,
        targetServerId: data.targetServerId,
        enabled: data.enabled ?? true,
        dryRun: data.dryRun ?? true, // SAFETY: dry run ON by default
        syncMovies: data.syncMovies ?? true,
        syncShows: data.syncShows ?? true,
        syncInProgress: data.syncInProgress ?? true,
        intervalMinutes: data.intervalMinutes ?? 60,
      })
      .returning();

    if (!created) {
      throw new Error('Failed to create watch sync config');
    }

    return this.getConfig(created.id) as Promise<WatchSyncConfig>;
  }

  /**
   * Update a watch sync configuration
   */
  async updateConfig(
    configId: string,
    data: Partial<{
      enabled: boolean;
      dryRun: boolean;
      syncMovies: boolean;
      syncShows: boolean;
      syncInProgress: boolean;
      intervalMinutes: number;
    }>
  ): Promise<WatchSyncConfig | null> {
    const [updated] = await db
      .update(watchSyncConfigs)
      .set(data)
      .where(eq(watchSyncConfigs.id, configId))
      .returning();

    if (!updated) return null;

    return this.getConfig(configId);
  }

  /**
   * Delete a watch sync configuration
   */
  async deleteConfig(configId: string): Promise<boolean> {
    const result = await db.delete(watchSyncConfigs).where(eq(watchSyncConfigs.id, configId));
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Get user mappings for a config
   */
  async getUserMappings(configId: string): Promise<WatchSyncUserMapping[]> {
    // Get config to check server types
    const config = await db.query.watchSyncConfigs.findFirst({
      where: eq(watchSyncConfigs.id, configId),
      with: {
        sourceServer: true,
        targetServer: true,
      },
    });

    const sourceIsPlex = config?.sourceServer?.type === 'plex';
    const targetIsPlex = config?.targetServer?.type === 'plex';

    const result = await db.query.watchSyncUserMappings.findMany({
      where: eq(watchSyncUserMappings.configId, configId),
      with: {
        sourceServerUser: true,
        targetServerUser: true,
      },
    });

    return result.map((r) => ({
      id: r.id,
      configId: r.configId,
      sourceServerUserId: r.sourceServerUserId,
      sourceUsername: r.sourceServerUser?.username,
      targetServerUserId: r.targetServerUserId,
      targetUsername: r.targetServerUser?.username,
      enabled: r.enabled,
      // Flag Plex users missing their serverToken (non-admin users need this for per-user watch status)
      sourceMissingToken:
        sourceIsPlex && !r.sourceServerUser?.isServerAdmin && !r.sourceServerUser?.plexServerToken,
      targetMissingToken:
        targetIsPlex && !r.targetServerUser?.isServerAdmin && !r.targetServerUser?.plexServerToken,
    }));
  }

  /**
   * Add a user mapping
   */
  async addUserMapping(data: {
    configId: string;
    sourceServerUserId: string;
    targetServerUserId: string;
    enabled?: boolean;
  }): Promise<WatchSyncUserMapping> {
    // Get the config to find its servers
    const config = await db.query.watchSyncConfigs.findFirst({
      where: eq(watchSyncConfigs.id, data.configId),
    });

    if (!config) {
      throw new Error('Config not found');
    }

    // Validate that the provided users belong to the config's source/target servers
    const [sourceUser, targetUser] = await Promise.all([
      db.query.serverUsers.findFirst({
        where: and(
          eq(serverUsers.id, data.sourceServerUserId),
          eq(serverUsers.serverId, config.sourceServerId)
        ),
      }),
      db.query.serverUsers.findFirst({
        where: and(
          eq(serverUsers.id, data.targetServerUserId),
          eq(serverUsers.serverId, config.targetServerId)
        ),
      }),
    ]);

    if (!sourceUser || !targetUser) {
      throw new Error('User mapping does not match source/target servers');
    }

    // Create the mapping for this config
    const [created] = await db
      .insert(watchSyncUserMappings)
      .values({
        configId: data.configId,
        sourceServerUserId: data.sourceServerUserId,
        targetServerUserId: data.targetServerUserId,
        enabled: data.enabled ?? true,
      })
      .returning();

    if (!created) {
      throw new Error('Failed to create user mapping');
    }

    // Check for sibling config (same servers, opposite direction) and create reverse mapping
    const siblingConfig = await db.query.watchSyncConfigs.findFirst({
      where: and(
        eq(watchSyncConfigs.sourceServerId, config.targetServerId),
        eq(watchSyncConfigs.targetServerId, config.sourceServerId)
      ),
    });

    if (siblingConfig) {
      // Create the reverse mapping for the sibling config (if not already exists)
      // Uses onConflictDoNothing to handle race conditions atomically
      await db
        .insert(watchSyncUserMappings)
        .values({
          configId: siblingConfig.id,
          sourceServerUserId: data.targetServerUserId, // Swap source/target
          targetServerUserId: data.sourceServerUserId,
          enabled: data.enabled ?? true,
        })
        .onConflictDoNothing();
    }

    const result = await db.query.watchSyncUserMappings.findFirst({
      where: eq(watchSyncUserMappings.id, created.id),
      with: {
        sourceServerUser: true,
        targetServerUser: true,
      },
    });

    if (!result) {
      throw new Error('Failed to create user mapping - record not found after insert');
    }

    return {
      id: result.id,
      configId: result.configId,
      sourceServerUserId: result.sourceServerUserId,
      sourceUsername: result.sourceServerUser?.username,
      targetServerUserId: result.targetServerUserId,
      targetUsername: result.targetServerUser?.username,
      enabled: result.enabled,
    };
  }

  /**
   * Remove a user mapping
   */
  async removeUserMapping(mappingId: string): Promise<boolean> {
    // First get the mapping details so we can find and remove the reverse
    const mapping = await db.query.watchSyncUserMappings.findFirst({
      where: eq(watchSyncUserMappings.id, mappingId),
      with: {
        config: true,
      },
    });

    if (!mapping) {
      return false;
    }

    // Delete the mapping
    const result = await db
      .delete(watchSyncUserMappings)
      .where(eq(watchSyncUserMappings.id, mappingId));

    if (result.rowCount === null || result.rowCount === 0) {
      return false;
    }

    // Check for sibling config and remove reverse mapping
    const siblingConfig = await db.query.watchSyncConfigs.findFirst({
      where: and(
        eq(watchSyncConfigs.sourceServerId, mapping.config.targetServerId),
        eq(watchSyncConfigs.targetServerId, mapping.config.sourceServerId)
      ),
    });

    if (siblingConfig) {
      // Delete the reverse mapping if it exists
      await db
        .delete(watchSyncUserMappings)
        .where(
          and(
            eq(watchSyncUserMappings.configId, siblingConfig.id),
            eq(watchSyncUserMappings.sourceServerUserId, mapping.targetServerUserId),
            eq(watchSyncUserMappings.targetServerUserId, mapping.sourceServerUserId)
          )
        );
    }

    return true;
  }

  /**
   * Get mapped users for a config with their external IDs
   */
  async getMappedUsers(configId: string): Promise<UserMappingWithDetails[]> {
    const result = await this.getMappedUsersWithSkipped(configId);
    return result.validMappings;
  }

  /**
   * Get mapped users for a config, returning both valid mappings and skipped users
   * Used internally by syncConfig to track skipped users for reporting
   */
  private async getMappedUsersWithSkipped(configId: string): Promise<{
    validMappings: UserMappingWithDetails[];
    skippedUsers: WatchSyncSkippedUser[];
  }> {
    // Get config to check server types
    const config = await db.query.watchSyncConfigs.findFirst({
      where: eq(watchSyncConfigs.id, configId),
      with: {
        sourceServer: true,
        targetServer: true,
      },
    });

    if (!config) return { validMappings: [], skippedUsers: [] };

    const sourceIsPlex = config.sourceServer?.type === 'plex';
    const targetIsPlex = config.targetServer?.type === 'plex';

    const mappings = await db.query.watchSyncUserMappings.findMany({
      where: and(
        eq(watchSyncUserMappings.configId, configId),
        eq(watchSyncUserMappings.enabled, true)
      ),
      with: {
        sourceServerUser: true,
        targetServerUser: true,
      },
    });

    const validMappings: UserMappingWithDetails[] = [];
    const skippedUsers: WatchSyncSkippedUser[] = [];

    // Filter out users missing required Plex tokens and track skipped users
    for (const m of mappings) {
      const sourceUser = m.sourceServerUser;
      const targetUser = m.targetServerUser;

      // Plex non-admin users need their serverToken for per-user watch status
      const sourceMissingToken =
        sourceIsPlex && !sourceUser?.isServerAdmin && !sourceUser?.plexServerToken;
      const targetMissingToken =
        targetIsPlex && !targetUser?.isServerAdmin && !targetUser?.plexServerToken;

      if (sourceMissingToken || targetMissingToken) {
        const missing: string[] = [];
        if (sourceMissingToken) missing.push(`source user "${sourceUser?.username}"`);
        if (targetMissingToken) missing.push(`target user "${targetUser?.username}"`);
        console.warn(
          `[WatchSync] Skipping user mapping ${sourceUser?.username} → ${targetUser?.username}: ` +
            `${missing.join(' and ')} missing Plex serverToken. Sync the Plex server to fix.`
        );

        // Track skipped users - use source username as the identifier
        const username = `${sourceUser?.username ?? 'Unknown'} → ${targetUser?.username ?? 'Unknown'}`;
        skippedUsers.push({
          username,
          reason: 'missing_token',
        });
        continue;
      }

      validMappings.push({
        sourceServerUserId: m.sourceServerUserId,
        sourceExternalId: m.sourceServerUser?.externalId ?? '',
        sourceUsername: m.sourceServerUser?.username ?? '',
        sourcePlexServerToken: m.sourceServerUser?.plexServerToken,
        targetServerUserId: m.targetServerUserId,
        targetExternalId: m.targetServerUser?.externalId ?? '',
        targetUsername: m.targetServerUser?.username ?? '',
        targetPlexServerToken: m.targetServerUser?.plexServerToken,
      });
    }

    return { validMappings, skippedUsers };
  }

  /**
   * Create a media server client for a server
   */
  private async createClient(serverId: string): Promise<IMediaServerClientWithWatchSync | null> {
    const server = await db.query.servers.findFirst({
      where: eq(servers.id, serverId),
    });

    if (!server) return null;

    switch (server.type) {
      case 'plex':
        return new PlexClient({ url: server.url, token: server.token });
      case 'jellyfin':
        return new JellyfinClient({ url: server.url, token: server.token });
      case 'emby':
        return new EmbyClient({ url: server.url, token: server.token });
      default:
        return null;
    }
  }

  /**
   * Update the lastSyncAt and lastSyncResult for a config
   */
  private async updateSyncResult(configId: string, result: WatchSyncResult): Promise<void> {
    await db
      .update(watchSyncConfigs)
      .set({
        lastSyncAt: new Date(),
        lastSyncResult: result,
      })
      .where(eq(watchSyncConfigs.id, configId));
  }

  /**
   * Sync watched items from source to target server for mapped users
   *
   * @param config - The sync configuration
   * @param onProgress - Optional callback for progress updates
   * @returns Sync result with statistics
   */
  async syncConfig(
    config: WatchSyncConfig,
    onProgress?: (progress: WatchSyncProgress) => void
  ): Promise<WatchSyncResult> {
    const startTime = Date.now();

    const progress: WatchSyncProgress = {
      status: 'idle',
      configId: config.id,
      dryRun: config.dryRun,
      sourceServer: config.sourceServerName ?? 'Unknown',
      targetServer: config.targetServerName ?? 'Unknown',
      totalItems: 0,
      processedItems: 0,
      syncedItems: 0,
      skippedItems: 0,
      errorCount: 0,
      message: 'Starting sync...',
      startedAt: new Date().toISOString(),
    };

    const updateProgress = (updates: Partial<WatchSyncProgress>) => {
      Object.assign(progress, updates);
      onProgress?.(progress);
    };

    try {
      // Get mapped users (including those skipped due to missing tokens)
      const { validMappings: mappedUsers, skippedUsers } = await this.getMappedUsersWithSkipped(
        config.id
      );
      if (mappedUsers.length === 0) {
        const result: WatchSyncResult = {
          success: true,
          synced: 0,
          skipped: 0,
          errors: 0,
          durationMs: Date.now() - startTime,
          message:
            skippedUsers.length > 0
              ? `No valid user mappings (${skippedUsers.length} skipped due to missing tokens)`
              : 'No user mappings configured',
          timestamp: new Date().toISOString(),
          skippedUsers: skippedUsers.length > 0 ? skippedUsers : undefined,
        };
        await this.updateSyncResult(config.id, result);
        return result;
      }

      // Create clients
      const sourceClient = await this.createClient(config.sourceServerId);
      const targetClient = await this.createClient(config.targetServerId);

      if (!sourceClient || !targetClient) {
        throw new Error('Failed to create media server clients');
      }

      let totalSynced = 0;
      let totalSkipped = 0;
      let totalErrors = 0;
      const previewItems: WatchSyncPreviewItem[] = [];
      // Track users skipped due to fetch failures (in addition to missing tokens)
      const allSkippedUsers: WatchSyncSkippedUser[] = [...skippedUsers];

      // Process each mapped user
      for (const userMapping of mappedUsers) {
        updateProgress({
          status: 'fetching_source',
          message: `Fetching watched items for ${userMapping.sourceUsername}...`,
        });

        // Fetch watched items from source
        // Pass user's Plex server token for per-user watch status (Plex only)
        let sourceItems: WatchedItem[];
        try {
          sourceItems = await sourceClient.getWatchedItems(userMapping.sourceExternalId, {
            includeInProgress: config.syncInProgress,
            userToken: userMapping.sourcePlexServerToken ?? undefined,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          console.error(`Failed to fetch source items for ${userMapping.sourceUsername}:`, error);
          allSkippedUsers.push({
            username: `${userMapping.sourceUsername} → ${userMapping.targetUsername}`,
            reason: 'fetch_failed',
            error: `Source fetch failed: ${errorMsg}`,
          });
          totalErrors++;
          continue;
        }

        // Filter by content type
        sourceItems = sourceItems.filter((item) => {
          if (item.type === 'movie' && !config.syncMovies) return false;
          if (item.type === 'episode' && !config.syncShows) return false;
          return true;
        });

        // Deduplicate source items (same movie/episode may appear in multiple libraries)
        const seenItems = new Set<string>();
        sourceItems = sourceItems.filter((item) => {
          // Create a unique key based on provider IDs or title
          let key: string;
          if (item.type === 'movie') {
            key =
              item.imdbId || item.tmdbId?.toString() || `movie:${item.title}:${item.year ?? ''}`;
          } else {
            // For episodes, use show ID + season + episode
            const showKey =
              item.showImdbId ||
              item.showTmdbId?.toString() ||
              item.showTvdbId?.toString() ||
              item.showTitle;
            key = `episode:${showKey}:S${item.seasonNumber}E${item.episodeNumber}`;
          }
          if (seenItems.has(key)) {
            return false;
          }
          seenItems.add(key);
          return true;
        });

        updateProgress({
          status: 'fetching_target',
          message: `Fetching watched items from target for ${userMapping.targetUsername}...`,
          totalItems: progress.totalItems + sourceItems.length,
        });

        // Fetch ALL items from target for comparison (including unwatched)
        // This allows syncing watch state to items that haven't been watched yet
        // Pass user's Plex server token for per-user watch status (Plex only)
        let targetItems: WatchedItem[];
        try {
          targetItems = await targetClient.getWatchedItems(userMapping.targetExternalId, {
            includeInProgress: true,
            includeUnwatched: true, // Fetch ALL items so we can sync to unwatched ones
            userToken: userMapping.targetPlexServerToken ?? undefined,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          console.error(`Failed to fetch target items for ${userMapping.targetUsername}:`, error);
          allSkippedUsers.push({
            username: `${userMapping.sourceUsername} → ${userMapping.targetUsername}`,
            reason: 'fetch_failed',
            error: `Target fetch failed: ${errorMsg}`,
          });
          totalErrors++;
          continue;
        }

        updateProgress({
          status: 'matching',
          message: `Matching ${sourceItems.length} items...`,
        });

        const logPrefix = `[WatchSync] ${userMapping.sourceUsername} -> ${userMapping.targetUsername}`;

        // Build lookup for fast matching
        const targetLookup = buildMatchLookup(targetItems);
        console.log(
          `${logPrefix} Source items: ${sourceItems.length}, Target items: ${targetItems.length}`
        );

        // Match and sync items
        updateProgress({
          status: 'syncing',
          message: `Syncing items for ${userMapping.sourceUsername} → ${userMapping.targetUsername}...`,
        });

        let matchedCount = 0;
        let noMatchCount = 0;
        let notBetterCount = 0;

        for (const sourceItem of sourceItems) {
          progress.processedItems++;

          // Find ALL matching items on target (may be multiple copies in different libraries)
          const targetMatches = matchItemFast(sourceItem, targetLookup);

          // No matching item found on target - cannot sync
          if (targetMatches.length === 0) {
            totalSkipped++;
            noMatchCount++;
            updateProgress({
              skippedItems: progress.skippedItems + 1,
              message: `Skipped (no match): ${sourceItem.title}`,
            });
            continue;
          }

          // Process each target match (sync to ALL copies)
          let anyMatched = false;

          if (config.dryRun) {
            const formatTitle = (item: typeof sourceItem) => {
              if (item.type === 'episode') {
                return `${item.showTitle} - S${String(item.seasonNumber ?? 0).padStart(2, '0')}E${String(item.episodeNumber ?? 0).padStart(2, '0')} - ${item.title}`;
              }
              return item.title;
            };
            const srcTitle = formatTitle(sourceItem);

            const sourceProgress = sourceItem.completed
              ? 100
              : sourceItem.progressMs > 0 && sourceItem.totalDurationMs
                ? Math.round((sourceItem.progressMs / sourceItem.totalDurationMs) * 100)
                : undefined;

            const syncableTargets = targetMatches.filter((target) =>
              shouldSync(sourceItem, target)
            );
            if (syncableTargets.length > 0) {
              anyMatched = true;
              totalSynced++;

              const targetSummaries = syncableTargets.map((target) => {
                const targetProgress = target.completed
                  ? 100
                  : target.progressMs > 0 && target.totalDurationMs
                    ? Math.round((target.progressMs / target.totalDurationMs) * 100)
                    : 0;

                return {
                  libraryName: target.libraryName,
                  serverItemId: target.serverItemId,
                  title: formatTitle(target),
                  progress: targetProgress,
                  progressMs: target.progressMs,
                  durationMs: target.totalDurationMs,
                  viewedAt: target.viewedAt?.toISOString(),
                  completed: target.completed,
                };
              });

              // Note: For Plex targets, marking one copy watched updates all duplicates server-side.
              // We still only carry a single targetServerItemId for selective sync to avoid redundant writes.
              const primaryTarget = targetSummaries[0];
              if (!primaryTarget) {
                continue;
              }
              const targetLibraryList = [
                ...new Set(targetSummaries.map((t) => t.libraryName ?? 'Unknown')),
              ];

              previewItems.push({
                title: `${srcTitle} → ${primaryTarget.title}`, // Deprecated, for backward compat
                sourceTitle: srcTitle,
                targetTitle: primaryTarget.title,
                type: sourceItem.type,
                year: sourceItem.year,
                showTitle: sourceItem.showTitle,
                seasonNumber: sourceItem.seasonNumber,
                episodeNumber: sourceItem.episodeNumber,
                sourceServer: config.sourceServerName ?? 'Unknown',
                targetServer: config.targetServerName ?? 'Unknown',
                sourceLibrary: sourceItem.libraryName,
                targetLibrary: targetLibraryList.join(', '),
                targetLibraries: targetSummaries,
                sourceServerUserId: userMapping.sourceServerUserId,
                targetServerUserId: userMapping.targetServerUserId,
                sourceUsername: userMapping.sourceUsername,
                targetUsername: userMapping.targetUsername,
                // Target item ID needed for selective sync
                targetServerItemId: primaryTarget.serverItemId,
                action: sourceItem.completed ? 'mark_watched' : 'update_progress',
                sourceProgress,
                targetProgress: primaryTarget.progress,
                // Raw ms values for sync
                sourceProgressMs: sourceItem.progressMs,
                targetProgressMs: primaryTarget.progressMs,
                sourceDurationMs: sourceItem.totalDurationMs,
                targetDurationMs: primaryTarget.durationMs,
                // Last watched timestamps
                sourceViewedAt: sourceItem.viewedAt?.toISOString(),
                targetViewedAt: primaryTarget.viewedAt,
              });

              updateProgress({
                syncedItems: progress.syncedItems + 1,
                message: `Preview: ${sourceItem.title} → ${primaryTarget.title}`,
              });
            }
          }

          if (!config.dryRun) {
            for (const targetItem of targetMatches) {
              // Determine if we should sync to this target copy
              if (!shouldSync(sourceItem, targetItem)) {
                continue; // Skip this target copy, try next
              }

              anyMatched = true;

              // Actually sync the item
              // Pass user's Plex server token for per-user write operations (Plex only)
              const targetUserToken = userMapping.targetPlexServerToken ?? undefined;
              try {
                if (sourceItem.completed) {
                  // Mark as watched
                  const success = await targetClient.markWatched(
                    userMapping.targetExternalId,
                    targetItem.serverItemId,
                    sourceItem.viewedAt,
                    targetUserToken
                  );
                  if (success) {
                    totalSynced++;
                    updateProgress({
                      syncedItems: progress.syncedItems + 1,
                      message: `Synced: ${sourceItem.title} → ${targetItem.title}`,
                    });
                  } else {
                    totalErrors++;
                    updateProgress({
                      errorCount: progress.errorCount + 1,
                    });
                  }
                } else if (sourceItem.progressMs > 0) {
                  // Update progress for in-progress items
                  const success = await targetClient.updateProgress(
                    userMapping.targetExternalId,
                    targetItem.serverItemId,
                    sourceItem.progressMs,
                    targetUserToken
                  );
                  if (success) {
                    totalSynced++;
                    updateProgress({
                      syncedItems: progress.syncedItems + 1,
                      message: `Updated progress: ${sourceItem.title} → ${targetItem.title}`,
                    });
                  } else {
                    totalErrors++;
                    updateProgress({
                      errorCount: progress.errorCount + 1,
                    });
                  }
                }
              } catch (error) {
                console.error(
                  `Failed to sync item ${sourceItem.title} → ${targetItem.title}:`,
                  error
                );
                totalErrors++;
                updateProgress({
                  errorCount: progress.errorCount + 1,
                });
              }
            } // End of for (targetItem of targetMatches)
          }

          // Track if this source item had no matches that needed sync
          if (!anyMatched && targetMatches.length > 0) {
            totalSkipped++;
            notBetterCount++;
            updateProgress({
              skippedItems: progress.skippedItems + 1,
            });
          } else if (anyMatched) {
            matchedCount++;
          }
        }

        console.log(
          `${logPrefix} Matched: ${matchedCount}, No match: ${noMatchCount}, Not better: ${notBetterCount}`
        );
      }

      // Complete
      const hasPreviewItems = config.dryRun && previewItems.length > 0;
      const hasSkippedUsers = allSkippedUsers.length > 0;
      const result: WatchSyncResult = {
        success: totalErrors === 0,
        synced: totalSynced,
        skipped: totalSkipped,
        errors: totalErrors,
        durationMs: Date.now() - startTime,
        message: config.dryRun
          ? `Preview complete: ${totalSynced} items ready to sync`
          : `Sync complete: ${totalSynced} items synced, ${totalSkipped} skipped, ${totalErrors} errors`,
        timestamp: new Date().toISOString(),
        // Include preview items list for selective sync
        previewItems: hasPreviewItems ? previewItems : undefined,
        dryRunItems: hasPreviewItems ? previewItems : undefined, // Backward compat
        // Include skipped users for visibility
        skippedUsers: hasSkippedUsers ? allSkippedUsers : undefined,
      };

      updateProgress({
        status: 'complete',
        message: result.message,
        completedAt: new Date().toISOString(),
      });

      await this.updateSyncResult(config.id, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const result: WatchSyncResult = {
        success: false,
        synced: 0,
        skipped: 0,
        errors: 1,
        durationMs: Date.now() - startTime,
        message: `Sync failed: ${message}`,
        timestamp: new Date().toISOString(),
      };

      updateProgress({
        status: 'error',
        message: result.message,
        errorCount: 1,
        completedAt: new Date().toISOString(),
      });

      await this.updateSyncResult(config.id, result);
      return result;
    }
  }

  /**
   * Sync selected preview items
   * This allows users to approve and sync specific items from a preview
   */
  async syncSelectedItems(
    configId: string,
    items: WatchSyncPreviewItem[],
    updateProgress?: (update: Partial<WatchSyncProgress>) => void
  ): Promise<WatchSyncResult> {
    const startTime = Date.now();
    const noop = () => undefined;
    const emitProgress = updateProgress ?? noop;

    // Get config
    const config = await this.getConfig(configId);
    if (!config) {
      return {
        success: false,
        synced: 0,
        skipped: 0,
        errors: 1,
        durationMs: Date.now() - startTime,
        message: 'Configuration not found',
        timestamp: new Date().toISOString(),
      };
    }

    if (items.length === 0) {
      return {
        success: true,
        synced: 0,
        skipped: 0,
        errors: 0,
        durationMs: Date.now() - startTime,
        message: 'No items to sync',
        timestamp: new Date().toISOString(),
      };
    }

    // Create target client
    const targetClient = await this.createClient(config.targetServerId);
    if (!targetClient) {
      return {
        success: false,
        synced: 0,
        skipped: 0,
        errors: 1,
        durationMs: Date.now() - startTime,
        message: 'Failed to create target server client',
        timestamp: new Date().toISOString(),
      };
    }

    // Get user mappings for Plex token lookup
    const userMappings = await this.getMappedUsers(configId);
    const userTokenMap = new Map<string, string | undefined>();
    for (const mapping of userMappings) {
      userTokenMap.set(mapping.targetServerUserId, mapping.targetPlexServerToken ?? undefined);
    }

    // Also need external IDs for API calls
    const targetUserIds = [...new Set(items.map((i) => i.targetServerUserId))];
    const targetUsers = await db.query.serverUsers.findMany({
      where: inArray(serverUsers.id, targetUserIds),
    });
    const userExternalIdMap = new Map<string, string>();
    for (const user of targetUsers) {
      userExternalIdMap.set(user.id, user.externalId);
    }

    let synced = 0;
    let skipped = 0;
    let errors = 0;

    emitProgress({
      status: 'syncing',
      totalItems: items.length,
      processedItems: 0,
      message: `Syncing ${items.length} selected items...`,
    });

    for (const [i, item] of items.entries()) {
      const targetExternalId = userExternalIdMap.get(item.targetServerUserId);
      const targetUserToken = userTokenMap.get(item.targetServerUserId);

      if (!targetExternalId) {
        console.error(`[WatchSync] No external ID for target user ${item.targetServerUserId}`);
        errors++;
        continue;
      }

      try {
        if (item.action === 'mark_watched') {
          const viewedAt = item.sourceViewedAt ? new Date(item.sourceViewedAt) : undefined;
          const success = await targetClient.markWatched(
            targetExternalId,
            item.targetServerItemId,
            viewedAt,
            targetUserToken
          );
          if (success) {
            synced++;
          } else {
            errors++;
          }
        } else if (item.action === 'update_progress' && item.sourceProgressMs !== undefined) {
          const success = await targetClient.updateProgress(
            targetExternalId,
            item.targetServerItemId,
            item.sourceProgressMs,
            targetUserToken
          );
          if (success) {
            synced++;
          } else {
            errors++;
          }
        } else {
          skipped++;
        }
      } catch (error) {
        console.error(`[WatchSync] Failed to sync item ${item.sourceTitle}:`, error);
        errors++;
      }

      emitProgress({
        processedItems: i + 1,
        syncedItems: synced,
        skippedItems: skipped,
        errorCount: errors,
        message: `Synced: ${item.sourceTitle}`,
      });
    }

    const result: WatchSyncResult = {
      success: errors === 0,
      synced,
      skipped,
      errors,
      durationMs: Date.now() - startTime,
      message: `Sync complete: ${synced} items synced, ${skipped} skipped, ${errors} errors`,
      timestamp: new Date().toISOString(),
    };

    emitProgress({
      status: 'complete',
      message: result.message,
      completedAt: new Date().toISOString(),
    });

    // Update the config's last sync result
    await this.updateSyncResult(configId, result);

    return result;
  }

  /**
   * Get users from both source and target servers for mapping UI
   */
  async getAvailableUsers(configId: string): Promise<{
    sourceUsers: Array<{ id: string; username: string; externalId: string }>;
    targetUsers: Array<{ id: string; username: string; externalId: string }>;
  }> {
    const config = await this.getConfig(configId);
    if (!config) {
      return { sourceUsers: [], targetUsers: [] };
    }

    // Get users from both servers
    const [sourceServerUsers, targetServerUsers] = await Promise.all([
      db.query.serverUsers.findMany({
        where: eq(serverUsers.serverId, config.sourceServerId),
      }),
      db.query.serverUsers.findMany({
        where: eq(serverUsers.serverId, config.targetServerId),
      }),
    ]);

    return {
      sourceUsers: sourceServerUsers.map((u) => ({
        id: u.id,
        username: u.username,
        externalId: u.externalId,
      })),
      targetUsers: targetServerUsers.map((u) => ({
        id: u.id,
        username: u.username,
        externalId: u.externalId,
      })),
    };
  }
}

// Export singleton instance
export const watchSyncService = new WatchSyncService();
