/**
 * Library Sync Service - Fetches library items from media servers and creates snapshots
 *
 * Orchestrates the library synchronization workflow:
 * 1. Fetch items from media server in batches with rate limiting
 * 2. Upsert items to libraryItems table
 * 3. Detect additions and removals (delta detection)
 * 4. Create snapshot with aggregate statistics
 * 5. Report progress via callback for real-time updates
 */

import { eq, and, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers, libraryItems, librarySnapshots } from '../db/schema.js';
import { createMediaServerClient, type MediaLibraryItem } from './mediaServer/index.js';
import type { LibrarySyncProgress } from '@tracearr/shared';

// Constants for batching and rate limiting
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 150;

/**
 * Result of syncing a single library
 */
export interface SyncResult {
  serverId: string;
  libraryId: string;
  libraryName: string;
  itemsProcessed: number;
  itemsAdded: number;
  itemsRemoved: number;
  snapshotId: string;
}

/**
 * Progress callback for real-time updates
 */
export type OnProgressCallback = (progress: LibrarySyncProgress) => void;

/**
 * Helper to delay between batches (rate limiting)
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Library Sync Service
 *
 * Handles fetching library items from media servers, persisting to database,
 * creating snapshots with quality statistics, and detecting delta changes.
 */
export class LibrarySyncService {
  /**
   * Sync all libraries for a server
   *
   * @param serverId - The server ID to sync
   * @param onProgress - Optional callback for progress updates
   * @returns Array of SyncResult for each library
   */
  async syncServer(serverId: string, onProgress?: OnProgressCallback): Promise<SyncResult[]> {
    const results: SyncResult[] = [];

    // Get server configuration
    const server = await this.getServer(serverId);
    if (!server) {
      throw new Error(`Server not found: ${serverId}`);
    }

    const startedAt = new Date().toISOString();

    // Create media server client
    const client = createMediaServerClient({
      type: server.type,
      url: server.url,
      token: server.token,
      id: server.id,
      name: server.name,
    });

    // Fetch all libraries
    const libraries = await client.getLibraries();
    const totalLibraries = libraries.length;

    // Report initial progress
    if (onProgress) {
      onProgress({
        serverId,
        serverName: server.name,
        status: 'running',
        totalLibraries,
        processedLibraries: 0,
        totalItems: 0,
        processedItems: 0,
        message: `Starting sync of ${totalLibraries} libraries...`,
        startedAt,
      });
    }

    // Sync each library
    for (let i = 0; i < libraries.length; i++) {
      const library = libraries[i]!;

      const result = await this.syncLibrary(
        serverId,
        server.name,
        library.id,
        library.name,
        client,
        onProgress,
        totalLibraries,
        i,
        startedAt
      );

      results.push(result);
    }

    // Report completion
    if (onProgress) {
      const totalItems = results.reduce((sum, r) => sum + r.itemsProcessed, 0);
      const totalAdded = results.reduce((sum, r) => sum + r.itemsAdded, 0);
      const totalRemoved = results.reduce((sum, r) => sum + r.itemsRemoved, 0);

      onProgress({
        serverId,
        serverName: server.name,
        status: 'complete',
        totalLibraries,
        processedLibraries: totalLibraries,
        totalItems,
        processedItems: totalItems,
        message: `Sync complete: ${totalItems} items, ${totalAdded} added, ${totalRemoved} removed`,
        startedAt,
        completedAt: new Date().toISOString(),
      });
    }

    return results;
  }

  /**
   * Sync a single library
   */
  private async syncLibrary(
    serverId: string,
    serverName: string,
    libraryId: string,
    libraryName: string,
    client: ReturnType<typeof createMediaServerClient>,
    onProgress: OnProgressCallback | undefined,
    totalLibraries: number,
    processedLibraries: number,
    startedAt: string
  ): Promise<SyncResult> {
    // Get previous item keys for delta detection
    const previousKeys = await this.getPreviousItemKeys(serverId, libraryId);
    const currentKeys = new Set<string>();
    const allItems: MediaLibraryItem[] = [];

    // Fetch total count first
    const { totalCount } = await client.getLibraryItems(libraryId, { offset: 0, limit: 1 });

    // Report starting library
    if (onProgress) {
      onProgress({
        serverId,
        serverName,
        status: 'running',
        currentLibrary: libraryId,
        currentLibraryName: libraryName,
        totalLibraries,
        processedLibraries,
        totalItems: totalCount,
        processedItems: 0,
        message: `Syncing library: ${libraryName} (${totalCount} items)...`,
        startedAt,
      });
    }

    // Fetch items in batches with pagination
    let offset = 0;
    let processedItems = 0;

    while (offset < totalCount) {
      const { items } = await client.getLibraryItems(libraryId, {
        offset,
        limit: BATCH_SIZE,
      });

      // No more items to process
      if (items.length === 0) break;

      // Track current keys for delta detection
      for (const item of items) {
        currentKeys.add(item.ratingKey);
        allItems.push(item);
      }

      // Upsert batch to database
      await this.upsertItems(serverId, libraryId, items);

      processedItems += items.length;
      offset += BATCH_SIZE;

      // Report progress
      if (onProgress) {
        onProgress({
          serverId,
          serverName,
          status: 'running',
          currentLibrary: libraryId,
          currentLibraryName: libraryName,
          totalLibraries,
          processedLibraries,
          totalItems: totalCount,
          processedItems,
          message: `${libraryName}: ${processedItems}/${totalCount} items processed...`,
          startedAt,
        });
      }

      // Rate limit between batches
      if (offset < totalCount) {
        await delay(BATCH_DELAY_MS);
      }
    }

    // For TV libraries (contains shows), also fetch all episodes
    const hasShows = allItems.some((item) => item.mediaType === 'show');
    if (hasShows && client.getLibraryLeaves) {
      // Report episode fetching
      if (onProgress) {
        onProgress({
          serverId,
          serverName,
          status: 'running',
          currentLibrary: libraryId,
          currentLibraryName: libraryName,
          totalLibraries,
          processedLibraries,
          totalItems: totalCount,
          processedItems,
          message: `${libraryName}: Fetching episodes...`,
          startedAt,
        });
      }

      // Fetch episode count
      const { totalCount: episodeCount } = await client.getLibraryLeaves(libraryId, {
        offset: 0,
        limit: 1,
      });

      // Fetch episodes in batches
      let episodeOffset = 0;
      let episodesProcessed = 0;

      while (episodeOffset < episodeCount) {
        const { items: episodes } = await client.getLibraryLeaves(libraryId, {
          offset: episodeOffset,
          limit: BATCH_SIZE,
        });

        if (episodes.length === 0) break;

        // Track episode keys and add to allItems
        for (const episode of episodes) {
          currentKeys.add(episode.ratingKey);
          allItems.push(episode);
        }

        // Upsert episodes to database
        await this.upsertItems(serverId, libraryId, episodes);

        episodesProcessed += episodes.length;
        episodeOffset += BATCH_SIZE;

        // Report progress
        if (onProgress) {
          onProgress({
            serverId,
            serverName,
            status: 'running',
            currentLibrary: libraryId,
            currentLibraryName: libraryName,
            totalLibraries,
            processedLibraries,
            totalItems: totalCount + episodeCount,
            processedItems: processedItems + episodesProcessed,
            message: `${libraryName}: ${episodesProcessed}/${episodeCount} episodes processed...`,
            startedAt,
          });
        }

        // Rate limit between batches
        if (episodeOffset < episodeCount) {
          await delay(BATCH_DELAY_MS);
        }
      }

      processedItems += episodesProcessed;
    }

    // For music libraries (contains artists), also fetch all tracks
    const hasArtists = allItems.some((item) => item.mediaType === 'artist');
    if (hasArtists && client.getLibraryLeaves) {
      // Report track fetching
      if (onProgress) {
        onProgress({
          serverId,
          serverName,
          status: 'running',
          currentLibrary: libraryId,
          currentLibraryName: libraryName,
          totalLibraries,
          processedLibraries,
          totalItems: totalCount,
          processedItems,
          message: `${libraryName}: Fetching tracks...`,
          startedAt,
        });
      }

      // Fetch track count
      const { totalCount: trackCount } = await client.getLibraryLeaves(libraryId, {
        offset: 0,
        limit: 1,
      });

      // Fetch tracks in batches
      let trackOffset = 0;
      let tracksProcessed = 0;

      while (trackOffset < trackCount) {
        const { items: tracks } = await client.getLibraryLeaves(libraryId, {
          offset: trackOffset,
          limit: BATCH_SIZE,
        });

        if (tracks.length === 0) break;

        // Track keys and add to allItems
        for (const track of tracks) {
          currentKeys.add(track.ratingKey);
          allItems.push(track);
        }

        // Upsert tracks to database
        await this.upsertItems(serverId, libraryId, tracks);

        tracksProcessed += tracks.length;
        trackOffset += BATCH_SIZE;

        // Report progress
        if (onProgress) {
          onProgress({
            serverId,
            serverName,
            status: 'running',
            currentLibrary: libraryId,
            currentLibraryName: libraryName,
            totalLibraries,
            processedLibraries,
            totalItems: totalCount + trackCount,
            processedItems: processedItems + tracksProcessed,
            message: `${libraryName}: ${tracksProcessed}/${trackCount} tracks processed...`,
            startedAt,
          });
        }

        // Rate limit between batches
        if (trackOffset < trackCount) {
          await delay(BATCH_DELAY_MS);
        }
      }

      processedItems += tracksProcessed;
    }

    // Calculate delta
    const addedKeys = [...currentKeys].filter((k) => !previousKeys.has(k));
    const removedKeys = [...previousKeys].filter((k) => !currentKeys.has(k));

    // Mark removed items (delete from database)
    if (removedKeys.length > 0) {
      await this.markItemsRemoved(serverId, libraryId, removedKeys);
    }

    // Create snapshot
    const snapshot = await this.createSnapshot(serverId, libraryId, allItems);

    return {
      serverId,
      libraryId,
      libraryName,
      itemsProcessed: processedItems,
      itemsAdded: addedKeys.length,
      itemsRemoved: removedKeys.length,
      snapshotId: snapshot.id,
    };
  }

  /**
   * Upsert items to libraryItems table
   *
   * Uses Drizzle's onConflictDoUpdate for atomic bulk upserts.
   * Conflict target: serverId + ratingKey
   * Wrapped in transaction for atomicity - partial failures will rollback.
   */
  async upsertItems(serverId: string, libraryId: string, items: MediaLibraryItem[]): Promise<void> {
    if (items.length === 0) return;

    // Bulk upsert with transaction for atomicity
    await db.transaction(async (tx) => {
      await tx
        .insert(libraryItems)
        .values(
          items.map((item) => ({
            serverId,
            libraryId,
            ratingKey: item.ratingKey,
            title: item.title,
            mediaType: item.mediaType,
            year: item.year ?? null,
            imdbId: item.imdbId ?? null,
            tmdbId: item.tmdbId ?? null,
            tvdbId: item.tvdbId ?? null,
            videoResolution: item.videoResolution ?? null,
            videoCodec: item.videoCodec ?? null,
            audioCodec: item.audioCodec ?? null,
            audioChannels: item.audioChannels ?? null,
            fileSize: item.fileSize ?? null,
            filePath: item.filePath ?? null,
            // Hierarchy fields (for episodes and tracks)
            grandparentTitle: item.grandparentTitle ?? null,
            grandparentRatingKey: item.grandparentRatingKey ?? null,
            parentTitle: item.parentTitle ?? null,
            parentRatingKey: item.parentRatingKey ?? null,
            parentIndex: item.parentIndex ?? null,
            itemIndex: item.itemIndex ?? null,
            // Use Plex's addedAt timestamp (when item was added to library)
            createdAt: item.addedAt,
          }))
        )
        .onConflictDoUpdate({
          target: [libraryItems.serverId, libraryItems.ratingKey],
          set: {
            libraryId,
            title: sql`excluded.title`,
            mediaType: sql`excluded.media_type`,
            year: sql`excluded.year`,
            imdbId: sql`excluded.imdb_id`,
            tmdbId: sql`excluded.tmdb_id`,
            tvdbId: sql`excluded.tvdb_id`,
            videoResolution: sql`excluded.video_resolution`,
            videoCodec: sql`excluded.video_codec`,
            audioCodec: sql`excluded.audio_codec`,
            audioChannels: sql`excluded.audio_channels`,
            fileSize: sql`excluded.file_size`,
            filePath: sql`excluded.file_path`,
            // Hierarchy fields (for episodes and tracks)
            grandparentTitle: sql`excluded.grandparent_title`,
            grandparentRatingKey: sql`excluded.grandparent_rating_key`,
            parentTitle: sql`excluded.parent_title`,
            parentRatingKey: sql`excluded.parent_rating_key`,
            parentIndex: sql`excluded.parent_index`,
            itemIndex: sql`excluded.item_index`,
            // Fix created_at with Plex's addedAt (for existing items with wrong dates)
            createdAt: sql`excluded.created_at`,
            updatedAt: new Date(),
          },
        });
    });
  }

  /**
   * Create a snapshot record with aggregate statistics
   */
  async createSnapshot(
    serverId: string,
    libraryId: string,
    items: MediaLibraryItem[]
  ): Promise<{ id: string }> {
    // Calculate quality distribution
    let count4k = 0;
    let count1080p = 0;
    let count720p = 0;
    let countSd = 0;
    let hevcCount = 0;
    let h264Count = 0;
    let av1Count = 0;
    let totalSize = 0;

    // Media type counts
    let movieCount = 0;
    let episodeCount = 0;
    let seasonCount = 0;
    let showCount = 0;
    let musicCount = 0;

    for (const item of items) {
      // Resolution counts
      const res = item.videoResolution?.toLowerCase();
      if (res === '4k' || res === '2160p' || res === 'uhd') {
        count4k++;
      } else if (res === '1080p' || res === '1080') {
        count1080p++;
      } else if (res === '720p' || res === '720') {
        count720p++;
      } else if (res) {
        countSd++;
      }

      // Codec counts
      const codec = item.videoCodec?.toLowerCase();
      if (codec === 'hevc' || codec === 'h265' || codec === 'x265') {
        hevcCount++;
      } else if (codec === 'h264' || codec === 'avc' || codec === 'x264') {
        h264Count++;
      } else if (codec === 'av1') {
        av1Count++;
      }

      // File size
      if (item.fileSize) {
        totalSize += item.fileSize;
      }

      // Media type counts
      switch (item.mediaType) {
        case 'movie':
          movieCount++;
          break;
        case 'episode':
          episodeCount++;
          break;
        case 'season':
          seasonCount++;
          break;
        case 'show':
          showCount++;
          break;
        case 'artist':
        case 'album':
        case 'track':
          musicCount++;
          break;
      }
    }

    // Insert snapshot
    const [snapshot] = await db
      .insert(librarySnapshots)
      .values({
        serverId,
        libraryId,
        snapshotTime: new Date(),
        itemCount: items.length,
        totalSize,
        movieCount,
        episodeCount,
        seasonCount,
        showCount,
        musicCount,
        count4k,
        count1080p,
        count720p,
        countSd,
        hevcCount,
        h264Count,
        av1Count,
        enrichmentPending: items.length, // All items need enrichment initially
        enrichmentComplete: 0,
      })
      .returning({ id: librarySnapshots.id });

    return { id: snapshot!.id };
  }

  /**
   * Get server configuration from database
   */
  private async getServer(serverId: string): Promise<{
    id: string;
    name: string;
    type: 'plex' | 'jellyfin' | 'emby';
    url: string;
    token: string;
  } | null> {
    const [server] = await db
      .select({
        id: servers.id,
        name: servers.name,
        type: servers.type,
        url: servers.url,
        token: servers.token,
      })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    return server ?? null;
  }

  /**
   * Get existing item keys for a library (for delta detection)
   */
  private async getPreviousItemKeys(serverId: string, libraryId: string): Promise<Set<string>> {
    const rows = await db
      .select({ ratingKey: libraryItems.ratingKey })
      .from(libraryItems)
      .where(and(eq(libraryItems.serverId, serverId), eq(libraryItems.libraryId, libraryId)));

    return new Set(rows.map((r) => r.ratingKey));
  }

  /**
   * Remove items that no longer exist in the library
   */
  async markItemsRemoved(serverId: string, libraryId: string, ratingKeys: string[]): Promise<void> {
    if (ratingKeys.length === 0) return;

    // Delete in batches to avoid query size limits
    const BATCH_SIZE = 100;
    for (let i = 0; i < ratingKeys.length; i += BATCH_SIZE) {
      const batch = ratingKeys.slice(i, i + BATCH_SIZE);
      await db
        .delete(libraryItems)
        .where(
          and(
            eq(libraryItems.serverId, serverId),
            eq(libraryItems.libraryId, libraryId),
            inArray(libraryItems.ratingKey, batch)
          )
        );
    }
  }
}

// Export singleton instance
export const librarySyncService = new LibrarySyncService();
