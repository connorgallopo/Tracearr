/**
 * Shared Test Helpers for Jellyfin/Emby Parser Tests
 *
 * Reusable assertion helpers and test utilities that can be used across
 * both Jellyfin and Emby parser tests to reduce code duplication.
 */

import { expect } from 'vitest';
import type { MediaSession, MediaUser, MediaLibrary, MediaWatchHistoryItem } from '../../types.js';

// ============================================================================
// Session Assertions
// ============================================================================

/**
 * Assert common session properties that are consistent across Jellyfin/Emby
 */
export function assertBaseSession(
  session: MediaSession | null,
  expected: {
    sessionKey?: string;
    mediaId?: string;
    mediaTitle?: string;
    mediaType?: MediaSession['media']['type'];
    playbackState?: MediaSession['playback']['state'];
    userId?: string;
    username?: string;
    playerName?: string;
    deviceId?: string;
    ipAddress?: string;
  }
): void {
  expect(session).not.toBeNull();
  if (!session) return;

  if (expected.sessionKey !== undefined) {
    expect(session.sessionKey).toBe(expected.sessionKey);
  }
  if (expected.mediaId !== undefined) {
    expect(session.mediaId).toBe(expected.mediaId);
  }
  if (expected.mediaTitle !== undefined) {
    expect(session.media.title).toBe(expected.mediaTitle);
  }
  if (expected.mediaType !== undefined) {
    expect(session.media.type).toBe(expected.mediaType);
  }
  if (expected.playbackState !== undefined) {
    expect(session.playback.state).toBe(expected.playbackState);
  }
  if (expected.userId !== undefined) {
    expect(session.user.id).toBe(expected.userId);
  }
  if (expected.username !== undefined) {
    expect(session.user.username).toBe(expected.username);
  }
  if (expected.playerName !== undefined) {
    expect(session.player.name).toBe(expected.playerName);
  }
  if (expected.deviceId !== undefined) {
    expect(session.player.deviceId).toBe(expected.deviceId);
  }
  if (expected.ipAddress !== undefined) {
    expect(session.network.ipAddress).toBe(expected.ipAddress);
  }
}

/**
 * Assert movie session properties
 */
export function assertMovieSession(
  session: MediaSession | null,
  expected: {
    durationMs?: number;
    year?: number;
    progressMs?: number;
    progressPercent?: number;
    isTranscode?: boolean;
  }
): void {
  expect(session).not.toBeNull();
  if (!session) return;

  expect(session.media.type).toBe('movie');

  if (expected.durationMs !== undefined) {
    expect(session.media.durationMs).toBe(expected.durationMs);
  }
  if (expected.year !== undefined) {
    expect(session.media.year).toBe(expected.year);
  }
  if (expected.progressMs !== undefined) {
    expect(session.playback.positionMs).toBe(expected.progressMs);
  }
  if (expected.progressPercent !== undefined) {
    expect(session.playback.progressPercent).toBe(expected.progressPercent);
  }
  if (expected.isTranscode !== undefined) {
    expect(session.quality.isTranscode).toBe(expected.isTranscode);
  }
}

/**
 * Assert episode session properties
 */
export function assertEpisodeSession(
  session: MediaSession | null,
  expected: {
    showTitle?: string;
    showId?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    seasonName?: string;
    showThumbPath?: string;
  }
): void {
  expect(session).not.toBeNull();
  if (!session) return;

  expect(session.media.type).toBe('episode');
  expect(session.episode).toBeDefined();

  if (!session.episode) return;

  if (expected.showTitle !== undefined) {
    expect(session.episode.showTitle).toBe(expected.showTitle);
  }
  if (expected.showId !== undefined) {
    expect(session.episode.showId).toBe(expected.showId);
  }
  if (expected.seasonNumber !== undefined) {
    expect(session.episode.seasonNumber).toBe(expected.seasonNumber);
  }
  if (expected.episodeNumber !== undefined) {
    expect(session.episode.episodeNumber).toBe(expected.episodeNumber);
  }
  if (expected.seasonName !== undefined) {
    expect(session.episode.seasonName).toBe(expected.seasonName);
  }
  if (expected.showThumbPath !== undefined) {
    expect(session.episode.showThumbPath).toBe(expected.showThumbPath);
  }
}

/**
 * Assert Live TV session properties
 */
export function assertLiveTvSession(
  session: MediaSession | null,
  expected: {
    channelTitle?: string;
    channelIdentifier?: string;
    channelThumb?: string;
  }
): void {
  expect(session).not.toBeNull();
  if (!session) return;

  expect(session.media.type).toBe('live');
  expect(session.live).toBeDefined();

  if (!session.live) return;

  if (expected.channelTitle !== undefined) {
    expect(session.live.channelTitle).toBe(expected.channelTitle);
  }
  if (expected.channelIdentifier !== undefined) {
    expect(session.live.channelIdentifier).toBe(expected.channelIdentifier);
  }
  if (expected.channelThumb !== undefined) {
    expect(session.live.channelThumb).toBe(expected.channelThumb);
  }
}

/**
 * Assert music track session properties
 */
export function assertMusicSession(
  session: MediaSession | null,
  expected: {
    artistName?: string;
    albumName?: string;
    trackNumber?: number;
    discNumber?: number;
  }
): void {
  expect(session).not.toBeNull();
  if (!session) return;

  expect(session.media.type).toBe('track');
  expect(session.music).toBeDefined();

  if (!session.music) return;

  if (expected.artistName !== undefined) {
    expect(session.music.artistName).toBe(expected.artistName);
  }
  if (expected.albumName !== undefined) {
    expect(session.music.albumName).toBe(expected.albumName);
  }
  if (expected.trackNumber !== undefined) {
    expect(session.music.trackNumber).toBe(expected.trackNumber);
  }
  if (expected.discNumber !== undefined) {
    expect(session.music.discNumber).toBe(expected.discNumber);
  }
}

// ============================================================================
// User Assertions
// ============================================================================

/**
 * Assert user properties
 */
export function assertUser(
  user: MediaUser | null,
  expected: {
    id?: string;
    username?: string;
    email?: string;
    isAdmin?: boolean;
    isDisabled?: boolean;
  }
): void {
  expect(user).not.toBeNull();
  if (!user) return;

  if (expected.id !== undefined) {
    expect(user.id).toBe(expected.id);
  }
  if (expected.username !== undefined) {
    expect(user.username).toBe(expected.username);
  }
  if (expected.email !== undefined) {
    expect(user.email).toBe(expected.email);
  }
  if (expected.isAdmin !== undefined) {
    expect(user.isAdmin).toBe(expected.isAdmin);
  }
  if (expected.isDisabled !== undefined) {
    expect(user.isDisabled).toBe(expected.isDisabled);
  }
}

// ============================================================================
// Library Assertions
// ============================================================================

/**
 * Assert library properties
 */
export function assertLibrary(
  library: MediaLibrary | null,
  expected: {
    id?: string;
    name?: string;
    type?: string;
    locations?: string[];
  }
): void {
  expect(library).not.toBeNull();
  if (!library) return;

  if (expected.id !== undefined) {
    expect(library.id).toBe(expected.id);
  }
  if (expected.name !== undefined) {
    expect(library.name).toBe(expected.name);
  }
  if (expected.type !== undefined) {
    expect(library.type).toBe(expected.type);
  }
  if (expected.locations !== undefined) {
    expect(library.locations).toEqual(expected.locations);
  }
}

// ============================================================================
// Watch History Assertions
// ============================================================================

/**
 * Assert watch history item properties
 */
export function assertWatchHistoryItem(
  item: MediaWatchHistoryItem | null,
  expected: {
    mediaId?: string;
    title?: string;
    type?: MediaWatchHistoryItem['type'];
    playCount?: number;
    showTitle?: string;
    seasonNumber?: number;
    episodeNumber?: number;
  }
): void {
  expect(item).not.toBeNull();
  if (!item) return;

  if (expected.mediaId !== undefined) {
    expect(item.mediaId).toBe(expected.mediaId);
  }
  if (expected.title !== undefined) {
    expect(item.title).toBe(expected.title);
  }
  if (expected.type !== undefined) {
    expect(item.type).toBe(expected.type);
  }
  if (expected.playCount !== undefined) {
    expect(item.playCount).toBe(expected.playCount);
  }
  if (expected.showTitle !== undefined) {
    expect(item.episode?.showTitle).toBe(expected.showTitle);
  }
  if (expected.seasonNumber !== undefined) {
    expect(item.episode?.seasonNumber).toBe(expected.seasonNumber);
  }
  if (expected.episodeNumber !== undefined) {
    expect(item.episode?.episodeNumber).toBe(expected.episodeNumber);
  }
}

// ============================================================================
// Quality Assertions
// ============================================================================

/**
 * Assert stream quality decisions
 */
export function assertQuality(
  session: MediaSession | null,
  expected: {
    isTranscode?: boolean;
    videoDecision?: string;
    audioDecision?: string;
    bitrate?: number;
  }
): void {
  expect(session).not.toBeNull();
  if (!session) return;

  if (expected.isTranscode !== undefined) {
    expect(session.quality.isTranscode).toBe(expected.isTranscode);
  }
  if (expected.videoDecision !== undefined) {
    expect(session.quality.videoDecision).toBe(expected.videoDecision);
  }
  if (expected.audioDecision !== undefined) {
    expect(session.quality.audioDecision).toBe(expected.audioDecision);
  }
  if (expected.bitrate !== undefined) {
    expect(session.quality.bitrate).toBe(expected.bitrate);
  }
}
