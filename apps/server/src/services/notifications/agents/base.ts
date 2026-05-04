/**
 * Base class for notification agents
 *
 * Provides common functionality and enforces the NotificationAgent interface.
 */

import type {
  NotificationAgent,
  NotificationPayload,
  NotificationSettings,
  NotificationEventType,
  SendResult,
  TestResult,
  ActiveSession,
} from '../types.js';
import type { ServerUser } from '@tracearr/shared';

/**
 * Abstract base class that all notification agents should extend.
 * Provides common utilities for formatting and error handling.
 */
export abstract class BaseAgent implements NotificationAgent {
  abstract readonly name: string;
  abstract readonly displayName: string;

  abstract shouldSend(event: NotificationEventType, settings: NotificationSettings): boolean;
  abstract send(payload: NotificationPayload, settings: NotificationSettings): Promise<SendResult>;
  abstract sendTest(settings: NotificationSettings): Promise<TestResult>;

  /**
   * Format duration in milliseconds to human-readable string
   */
  protected formatDuration(ms: number | null): string {
    if (ms === null || ms === undefined) {
      return 'Unknown';
    }

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      const remainingMinutes = minutes % 60;
      return `${hours}h ${remainingMinutes}m`;
    }
    if (minutes > 0) {
      const remainingSeconds = seconds % 60;
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${seconds}s`;
  }

  /**
   * Get display title for media (matches UI card logic)
   */
  protected getMediaDisplay(session: ActiveSession): { title: string; subtitle: string | null } {
    if (session.mediaType === 'episode' && session.grandparentTitle) {
      const episodeInfo =
        session.seasonNumber && session.episodeNumber
          ? `S${session.seasonNumber.toString().padStart(2, '0')} E${session.episodeNumber.toString().padStart(2, '0')}`
          : '';
      return {
        title: session.grandparentTitle,
        subtitle: episodeInfo ? `${episodeInfo} · ${session.mediaTitle}` : session.mediaTitle,
      };
    }
    return {
      title: session.mediaTitle,
      subtitle: session.year ? `${session.year}` : null,
    };
  }

  /**
   * Get playback type (matches UI badge logic)
   */
  protected getPlaybackType(session: ActiveSession): string {
    if (session.isTranscode) {
      return 'Transcode';
    }
    if (session.videoDecision === 'copy' || session.audioDecision === 'copy') {
      return 'Direct Stream';
    }
    return 'Direct Play';
  }

  /**
   * Get user display name
   */
  protected getUserDisplayName(session: ActiveSession): string {
    return session.user.identityName ?? session.user.username;
  }

  /**
   * Get the image URL of the user's avatar / thumbnail
   */
  protected getUserAvatarURL(user: Pick<ServerUser, 'thumbUrl'>): string | undefined {
    return user.thumbUrl ? user.thumbUrl : undefined;
  }

  /**
   * Get the image URL for the media's thumbnail
   */
  protected getMediaPosterURL(
    session: ActiveSession,
    netSettings: { externalUrl: string | null }
  ): string | undefined {
    if (!netSettings.externalUrl || !session.thumbPath) {
      return undefined;
    }

    const url = new URL('/api/v1/images/proxy', netSettings.externalUrl);

    url.searchParams.set('server', session.server.id);
    url.searchParams.set('url', session.thumbPath);
    url.searchParams.set('fallback', 'poster');

    return url.toString();
  }

  /**
   * Get the image URL for the server's icon
   */
  protected getServerIconURL(
    server: string | undefined,
    external: string | null
  ): string | undefined {
    if (server && external) {
      switch (server) {
        case 'plex':
          return `${external}/images/servers/plex.png`;
        case 'jellyfin':
          return `${external}/images/servers/jellyfin.png`;
        case 'emby':
          return `${external}/images/servers/emby.png`;
      }
    }

    return undefined;
  }

  /**
   * Get the integer value for the server's color
   */
  protected getServerColorForDiscord(server: string | undefined): number {
    switch (server) {
      case 'plex':
        return 15445760; // Plex Gold (https://brand.plex.tv/document/439975#/visual/color)
      case 'jellyfin':
        return 11164867; // Jellyfin Purple (https://jellyfin.org/docs/general/contributing/branding/#logo)
      case 'emby':
        return 5419850; // Emby Green (https://emby.media/resources/logowhite_1881.png)
      default:
        return 0x3498db; // Generic Blue
    }
  }

  /**
   * Handle and log errors consistently
   */
  protected handleError(error: unknown, context: string): SendResult {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${this.name}] ${context}: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
      agent: this.name,
    };
  }

  /**
   * Create a success result
   */
  protected successResult(): SendResult {
    return {
      success: true,
      agent: this.name,
    };
  }

  /**
   * Create a success test result
   */
  protected successTestResult(): TestResult {
    return { success: true };
  }

  /**
   * Create a failure test result
   */
  protected failureTestResult(error: string): TestResult {
    return { success: false, error };
  }

  /**
   * Build fetch-compatible URL and headers from a URL that may contain
   * embedded basic-auth credentials. Credentials are extracted and sent
   * as an Authorization header instead.
   */
  protected buildFetchOptions(rawUrl: string): {
    url: string;
    authHeaders: Record<string, string>;
  } {
    const parsed = new URL(rawUrl);
    const authHeaders: Record<string, string> = {};

    if (parsed.username || parsed.password) {
      const credentials = btoa(
        `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
      );
      authHeaders['Authorization'] = `Basic ${credentials}`;
      parsed.username = '';
      parsed.password = '';
    }

    return { url: parsed.toString(), authHeaders };
  }
}
