/**
 * Compact card showing an active streaming session
 * Displays poster, title, user, progress bar, and play/pause status
 */
import React from 'react';
import { View, Image, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/ui/text';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useAuthStore } from '@/lib/authStore';
import { useEstimatedProgress } from '@/hooks/useEstimatedProgress';
import { colors, spacing, borderRadius, typography } from '@/lib/theme';
import type { ActiveSession } from '@tracearr/shared';

interface NowPlayingCardProps {
  session: ActiveSession;
  onPress?: (session: ActiveSession) => void;
}

/**
 * Format duration in ms to readable string (HH:MM:SS or MM:SS)
 */
function formatDuration(ms: number | null): string {
  if (!ms) return '--:--';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Get display title for media (handles TV shows vs movies)
 */
function getMediaDisplay(session: ActiveSession): { title: string; subtitle: string | null } {
  if (session.mediaType === 'episode' && session.grandparentTitle) {
    // TV Show episode
    const episodeInfo =
      session.seasonNumber && session.episodeNumber
        ? `S${session.seasonNumber.toString().padStart(2, '0')}E${session.episodeNumber.toString().padStart(2, '0')}`
        : '';
    return {
      title: session.grandparentTitle,
      subtitle: episodeInfo ? `${episodeInfo} · ${session.mediaTitle}` : session.mediaTitle,
    };
  }
  // Movie or music
  return {
    title: session.mediaTitle,
    subtitle: session.year ? `${session.year}` : null,
  };
}

export function NowPlayingCard({ session, onPress }: NowPlayingCardProps) {
  const { serverUrl } = useAuthStore();
  const { title, subtitle } = getMediaDisplay(session);

  // Use estimated progress for smooth updates between SSE/poll events
  const { estimatedProgressMs, progressPercent } = useEstimatedProgress(session);

  // Build poster URL using image proxy
  const posterUrl =
    serverUrl && session.thumbPath
      ? `${serverUrl}/api/v1/images/proxy?server=${session.serverId}&url=${encodeURIComponent(session.thumbPath)}&width=80&height=120`
      : null;

  const isPaused = session.state === 'paused';
  const username = session.user?.username || 'Unknown';
  const userThumbUrl = session.user?.thumbUrl || null;

  return (
    <Pressable
      style={({ pressed }) => [styles.container, pressed && styles.pressed]}
      onPress={() => onPress?.(session)}
    >
      {/* Main content row */}
      <View style={styles.contentRow}>
        {/* Poster */}
        <View style={styles.posterContainer}>
          {posterUrl ? (
            <Image source={{ uri: posterUrl }} style={styles.poster} resizeMode="cover" />
          ) : (
            <View style={[styles.poster, styles.posterPlaceholder]}>
              <Ionicons name="film-outline" size={24} color={colors.text.muted.dark} />
            </View>
          )}
          {/* Paused overlay */}
          {isPaused && (
            <View style={styles.pausedOverlay}>
              <Ionicons name="pause" size={20} color={colors.text.primary.dark} />
            </View>
          )}
        </View>

        {/* Info section */}
        <View style={styles.info}>
          {/* Title + subtitle */}
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {subtitle && (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          )}

          {/* User + time row combined */}
          <View style={styles.userTimeRow}>
            <View style={styles.userSection}>
              <UserAvatar thumbUrl={userThumbUrl} username={username} size={16} />
              <Text style={styles.username} numberOfLines={1}>
                {username}
              </Text>
              {session.isTranscode && <Ionicons name="flash" size={10} color={colors.warning} />}
            </View>
            <View style={styles.timeSection}>
              <View style={[styles.statusDot, isPaused && styles.statusDotPaused]}>
                <Ionicons
                  name={isPaused ? 'pause' : 'play'}
                  size={6}
                  color={isPaused ? colors.warning : colors.cyan.core}
                />
              </View>
              <Text style={[styles.timeText, isPaused && styles.pausedText]}>
                {isPaused
                  ? 'Paused'
                  : `${formatDuration(estimatedProgressMs)} / ${formatDuration(session.totalDurationMs)}`}
              </Text>
            </View>
          </View>
        </View>

        {/* Chevron */}
        <View style={styles.chevron}>
          <Ionicons name="chevron-forward" size={16} color={colors.text.muted.dark} />
        </View>
      </View>

      {/* Bottom progress bar - full width */}
      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { width: `${progressPercent}%` }]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.card.dark,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.sm,
    overflow: 'hidden',
  },
  pressed: {
    opacity: 0.7,
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  posterContainer: {
    position: 'relative',
    marginRight: spacing.sm,
  },
  poster: {
    width: 50,
    height: 75,
    borderRadius: borderRadius.md,
    backgroundColor: colors.surface.dark,
  },
  posterPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  pausedOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: borderRadius.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  info: {
    flex: 1,
    justifyContent: 'center',
    gap: 2,
  },
  title: {
    fontSize: typography.fontSize.sm,
    fontWeight: '600',
    color: colors.text.primary.dark,
    lineHeight: 16,
  },
  subtitle: {
    fontSize: typography.fontSize.xs,
    color: colors.text.muted.dark,
  },
  userTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  userSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flex: 1,
  },
  username: {
    fontSize: typography.fontSize.xs,
    color: colors.text.secondary.dark,
  },
  timeSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: 'rgba(24, 209, 231, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  statusDotPaused: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
  },
  timeText: {
    fontSize: typography.fontSize.xs,
    color: colors.text.muted.dark,
  },
  pausedText: {
    color: colors.warning,
  },
  progressBar: {
    height: 3,
    backgroundColor: colors.surface.dark,
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.cyan.core,
  },
  chevron: {
    marginLeft: 4,
    opacity: 0.5,
  },
});
