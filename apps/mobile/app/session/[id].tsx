/**
 * Session detail screen
 * Shows comprehensive information about a specific session/stream
 * Matches the design of web/src/components/history/SessionDetailSheet.tsx
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  View,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Image,
  Alert,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { useState, useEffect } from 'react';
import {
  Play,
  Pause,
  Square,
  Server,
  MapPin,
  Smartphone,
  Clock,
  Gauge,
  Tv,
  Film,
  Music,
  Radio,
  ImageIcon,
  CircleHelp,
  Globe,
  MonitorPlay,
  Repeat2,
  Eye,
  ChevronRight,
  X,
  Clapperboard,
} from 'lucide-react-native';
import { api, getServerUrl } from '@/lib/api';
import { useMediaServer } from '@/providers/MediaServerProvider';
import { colors, spacing, borderRadius, withAlpha } from '@/lib/theme';
import { Text } from '@/components/ui/text';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/ui/user-avatar';
import { StreamDetailsPanel } from '@/components/session';
import type { SessionWithDetails, SessionState, MediaType, ServerType } from '@tracearr/shared';

// Server type configuration
const SERVER_CONFIG: Record<ServerType, { label: string; color: string }> = {
  plex: { label: 'Plex', color: '#E5A00D' },
  jellyfin: { label: 'Jellyfin', color: '#A855F7' },
  emby: { label: 'Emby', color: '#22C55E' },
};

// State configuration
const STATE_CONFIG: Record<SessionState, { icon: typeof Play; color: string; label: string }> = {
  playing: { icon: Play, color: colors.success, label: 'Playing' },
  paused: { icon: Pause, color: colors.warning, label: 'Paused' },
  stopped: { icon: Square, color: colors.text.muted.dark, label: 'Stopped' },
};

// Media type configuration
const MEDIA_CONFIG: Record<MediaType, { icon: typeof Film; label: string }> = {
  movie: { icon: Film, label: 'Movie' },
  episode: { icon: Tv, label: 'Episode' },
  track: { icon: Music, label: 'Track' },
  live: { icon: Radio, label: 'Live TV' },
  photo: { icon: ImageIcon, label: 'Photo' },
  trailer: { icon: Clapperboard, label: 'Trailer' },
  unknown: { icon: CircleHelp, label: 'Unknown' },
};

// Safe date parsing helper
function safeParseDate(date: Date | string | null | undefined): Date | null {
  if (!date) return null;
  const parsed = new Date(date);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// Format duration
function formatDuration(ms: number | null): string {
  if (!ms) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// Get watch time - for active sessions, calculate from elapsed time
function getWatchTime(session: SessionWithDetails): number | null {
  if (session.durationMs !== null) {
    return session.durationMs;
  }
  const startTime = safeParseDate(session.startedAt)?.getTime();
  if (!startTime) return null;
  const now = Date.now();
  const elapsedMs = now - startTime;
  const pausedMs = session.pausedDurationMs ?? 0;
  return Math.max(0, elapsedMs - pausedMs);
}

// Get progress percentage (playback position)
// Uses progressMs (where in the video) not durationMs (how long watched)
function getProgress(session: SessionWithDetails): number {
  if (!session.totalDurationMs || session.totalDurationMs === 0) return 0;
  const progress = session.progressMs ?? 0;
  return Math.min(100, Math.round((progress / session.totalDurationMs) * 100));
}

// Get media title formatted
function getMediaTitle(session: SessionWithDetails): { primary: string; secondary?: string } {
  if (session.mediaType === 'episode' && session.grandparentTitle) {
    const epNum =
      session.seasonNumber && session.episodeNumber
        ? `S${session.seasonNumber.toString().padStart(2, '0')} E${session.episodeNumber.toString().padStart(2, '0')}`
        : '';
    return {
      primary: session.grandparentTitle,
      secondary: `${epNum}${epNum ? ' · ' : ''}${session.mediaTitle}`,
    };
  }
  if (session.mediaType === 'track') {
    const parts: string[] = [];
    if (session.artistName) parts.push(session.artistName);
    if (session.albumName) parts.push(session.albumName);
    return {
      primary: session.mediaTitle,
      secondary: parts.length > 0 ? parts.join(' · ') : undefined,
    };
  }
  return {
    primary: session.mediaTitle,
    secondary: session.year ? `(${session.year})` : undefined,
  };
}

// Format transcode reason codes into human-friendly labels
function formatReason(reason: string): string {
  return reason
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
}

// Get country name from country code
function getCountryName(countryCode: string | null): string | null {
  if (!countryCode) return null;
  try {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
    return displayNames.of(countryCode) ?? countryCode;
  } catch {
    return countryCode;
  }
}

// Section container
function Section({
  icon: Icon,
  title,
  badge,
  children,
}: {
  icon: typeof Server;
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionHeaderLeft}>
          <View style={styles.sectionIconContainer}>
            <Icon size={14} color={colors.cyan.core} />
          </View>
          <Text style={styles.sectionTitle}>{title}</Text>
        </View>
        {badge}
      </View>
      {children}
    </View>
  );
}

// Info row component
function InfoRow({
  label,
  value,
  valueColor,
  subValue,
  mono,
}: {
  label: string;
  value: string;
  valueColor?: string;
  subValue?: string;
  mono?: boolean;
}) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <View style={styles.infoValueContainer}>
        <Text
          style={[
            styles.infoValue,
            valueColor ? { color: valueColor } : null,
            mono ? styles.monoText : null,
          ]}
          numberOfLines={1}
        >
          {value}
        </Text>
        {subValue && <Text style={styles.infoSubValue}>{subValue}</Text>}
      </View>
    </View>
  );
}

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { selectedServerId } = useMediaServer();
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void getServerUrl().then((url) => {
      if (mounted) setServerUrl(url);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Terminate session mutation
  const terminateMutation = useMutation({
    mutationFn: ({ sessionId, reason }: { sessionId: string; reason?: string }) =>
      api.sessions.terminate(sessionId, reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'active'] });
      Alert.alert('Stream Terminated', 'The playback session has been stopped.');
      router.back();
    },
    onError: (error: Error) => {
      Alert.alert('Failed to Terminate', error.message);
    },
  });

  const handleTerminate = () => {
    Alert.prompt(
      'Terminate Stream',
      'Enter an optional message to show the user (leave empty to skip):',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Terminate',
          style: 'destructive',
          onPress: (reason: string | undefined) => {
            terminateMutation.mutate({ sessionId: id, reason: reason?.trim() || undefined });
          },
        },
      ],
      'plain-text',
      '',
      'default'
    );
  };

  const {
    data: session,
    isLoading,
    error,
  } = useQuery<SessionWithDetails>({
    queryKey: ['session', id, selectedServerId],
    queryFn: () => api.sessions.get(id),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <SafeAreaView style={styles.loadingContainer} edges={['left', 'right', 'bottom']}>
        <ActivityIndicator size="large" color={colors.cyan.core} />
      </SafeAreaView>
    );
  }

  if (error || !session) {
    return (
      <SafeAreaView style={styles.errorContainer} edges={['left', 'right', 'bottom']}>
        <Text style={styles.errorText}>
          {error instanceof Error ? error.message : 'Failed to load session'}
        </Text>
      </SafeAreaView>
    );
  }

  const serverConfig = SERVER_CONFIG[session.server.type];
  const stateConfig = STATE_CONFIG[session.state];
  const mediaConfig = MEDIA_CONFIG[session.mediaType];
  const MediaIcon = mediaConfig.icon;
  const StateIcon = stateConfig.icon;
  const title = getMediaTitle(session);
  const progress = getProgress(session);

  // Get poster URL
  const posterUrl =
    session.thumbPath && serverUrl
      ? `${serverUrl}/api/v1/images/proxy?server=${session.serverId}&url=${encodeURIComponent(session.thumbPath)}&width=120&height=180&fallback=poster`
      : null;

  // Build location string
  const locationParts = [
    session.geoCity,
    session.geoRegion,
    getCountryName(session.geoCountry),
  ].filter(Boolean);
  const locationString = locationParts.join(', ');

  const transcodeReasons = session.transcodeInfo?.reasons ?? [];
  const hasTranscodeReason = transcodeReasons.length > 0;
  const transcodeReasonText = transcodeReasons.map(formatReason).join(', ');

  // Format dates safely
  const startedAt = safeParseDate(session.startedAt);
  const stoppedAt = safeParseDate(session.stoppedAt);

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Header with state badge and terminate button */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <StateIcon size={16} color={stateConfig.color} />
            <Text style={styles.headerTitle}>Session Details</Text>
            <Badge
              variant={
                session.state === 'playing'
                  ? 'success'
                  : session.state === 'paused'
                    ? 'warning'
                    : 'secondary'
              }
            >
              {stateConfig.label}
            </Badge>
          </View>
          {session.state !== 'stopped' && (
            <Pressable
              onPress={handleTerminate}
              disabled={terminateMutation.isPending}
              style={[styles.terminateButton, terminateMutation.isPending && styles.disabledButton]}
            >
              <X size={18} color={colors.error} />
            </Pressable>
          )}
        </View>

        {/* Media Info - Hero section */}
        <View style={styles.mediaCard}>
          {posterUrl && (
            <Image source={{ uri: posterUrl }} style={styles.poster} resizeMode="cover" />
          )}
          <View style={styles.mediaInfo}>
            <View style={styles.mediaTypeBadge}>
              <MediaIcon size={12} color={colors.text.muted.dark} />
              <Text style={styles.mediaTypeText}>{mediaConfig.label}</Text>
              {session.year && <Text style={styles.mediaTypeText}>· {session.year}</Text>}
            </View>
            <View style={styles.mediaTitleRow}>
              <Text style={styles.mediaTitle} numberOfLines={2}>
                {title.primary}
              </Text>
              {session.watched && <Eye size={14} color={colors.success} />}
            </View>
            {title.secondary && (
              <Text style={styles.mediaSubtitle} numberOfLines={1}>
                {title.secondary}
              </Text>
            )}
            {/* Progress inline */}
            <View style={styles.progressContainer}>
              <View style={styles.progressBar}>
                <View style={[styles.progressFill, { width: `${progress}%` }]} />
              </View>
              <Text style={styles.progressText}>{progress}%</Text>
            </View>
          </View>
        </View>

        {/* User - Tappable */}
        <Pressable
          style={styles.userCard}
          onPress={() => router.push(`/user/${session.serverUserId}` as never)}
        >
          <UserAvatar thumbUrl={session.user.thumbUrl} username={session.user.username} size={36} />
          <View style={styles.userInfo}>
            <Text style={styles.userName} numberOfLines={1}>
              {session.user.identityName ?? session.user.username}
            </Text>
            {session.user.identityName && session.user.identityName !== session.user.username && (
              <Text style={styles.userUsername}>@{session.user.username}</Text>
            )}
            {!session.user.identityName && <Text style={styles.userUsername}>View profile</Text>}
          </View>
          <ChevronRight size={16} color={colors.text.muted.dark} />
        </Pressable>

        {/* Server */}
        <Section icon={Server} title="Server">
          <View style={styles.serverRow}>
            <Text style={styles.serverLabel}>Server</Text>
            <View style={styles.serverValue}>
              <Text style={[styles.serverType, { color: serverConfig.color }]}>
                {serverConfig.label}
              </Text>
              <Text style={styles.serverDot}>·</Text>
              <Text style={styles.serverName}>{session.server.name}</Text>
            </View>
          </View>
        </Section>

        {/* Playback Info */}
        <Section
          icon={Clock}
          title="Playback"
          badge={
            session.segmentCount && session.segmentCount > 1 ? (
              <Badge variant="outline">{session.segmentCount} segments</Badge>
            ) : null
          }
        >
          <View style={styles.infoContent}>
            {startedAt && (
              <InfoRow
                label="Started"
                value={format(startedAt, 'MMM d, h:mm a')}
                subValue={formatDistanceToNow(startedAt, { addSuffix: true })}
              />
            )}
            {stoppedAt && <InfoRow label="Stopped" value={format(stoppedAt, 'MMM d, h:mm a')} />}
            <InfoRow label="Watch time" value={formatDuration(getWatchTime(session))} />
            {session.pausedDurationMs > 0 && (
              <InfoRow label="Paused" value={formatDuration(session.pausedDurationMs)} />
            )}
            {session.totalDurationMs && (
              <InfoRow label="Media length" value={formatDuration(session.totalDurationMs)} />
            )}
          </View>
        </Section>

        {/* Location & Network */}
        <Section icon={MapPin} title="Location">
          <View style={styles.infoContent}>
            <InfoRow label="IP Address" value={session.ipAddress || '—'} mono />
            {locationString && (
              <View style={styles.locationRow}>
                <Globe size={14} color={colors.text.muted.dark} />
                <Text style={styles.locationText}>{locationString}</Text>
              </View>
            )}
          </View>
        </Section>

        {/* Device */}
        <Section icon={Smartphone} title="Device">
          <View style={styles.infoContent}>
            {session.platform && <InfoRow label="Platform" value={session.platform} />}
            {session.product && <InfoRow label="Product" value={session.product} />}
            {session.device && <InfoRow label="Device" value={session.device} />}
            {session.playerName && <InfoRow label="Player" value={session.playerName} />}
            {session.deviceId && <InfoRow label="Device ID" value={session.deviceId} mono />}
          </View>
        </Section>

        {/* Stream Details */}
        <Section
          icon={Gauge}
          title="Stream Details"
          badge={
            <Badge variant={session.isTranscode ? 'warning' : 'secondary'}>
              <View style={styles.streamBadgeContent}>
                {session.isTranscode ? (
                  <>
                    <Repeat2 size={12} color={colors.warning} />
                    <Text style={styles.streamBadgeText}>Transcode</Text>
                  </>
                ) : session.videoDecision === 'copy' || session.audioDecision === 'copy' ? (
                  <>
                    <MonitorPlay size={12} color={colors.text.primary.dark} />
                    <Text style={styles.streamBadgeTextSecondary}>Direct Stream</Text>
                  </>
                ) : (
                  <>
                    <MonitorPlay size={12} color={colors.text.primary.dark} />
                    <Text style={styles.streamBadgeTextSecondary}>Direct Play</Text>
                  </>
                )}
              </View>
            </Badge>
          }
        >
          <StreamDetailsPanel
            sourceVideoCodec={session.sourceVideoCodec ?? null}
            sourceAudioCodec={session.sourceAudioCodec ?? null}
            sourceAudioChannels={session.sourceAudioChannels ?? null}
            sourceVideoWidth={session.sourceVideoWidth ?? null}
            sourceVideoHeight={session.sourceVideoHeight ?? null}
            streamVideoCodec={session.streamVideoCodec ?? null}
            streamAudioCodec={session.streamAudioCodec ?? null}
            sourceVideoDetails={session.sourceVideoDetails ?? null}
            sourceAudioDetails={session.sourceAudioDetails ?? null}
            streamVideoDetails={session.streamVideoDetails ?? null}
            streamAudioDetails={session.streamAudioDetails ?? null}
            transcodeInfo={session.transcodeInfo ?? null}
            subtitleInfo={session.subtitleInfo ?? null}
            videoDecision={session.videoDecision ?? null}
            audioDecision={session.audioDecision ?? null}
            bitrate={session.bitrate ?? null}
            serverType={session.server.type}
          />
        </Section>

        {/* Transcode reason tooltip equivalent */}
        {session.isTranscode && hasTranscodeReason && (
          <View style={styles.transcodeReasonCard}>
            <Text style={styles.transcodeReasonLabel}>Transcode Reason</Text>
            <Text style={styles.transcodeReasonText}>{transcodeReasonText}</Text>
          </View>
        )}

        {/* Bottom padding */}
        <View style={styles.bottomPadding} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.dark,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.background.dark,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorContainer: {
    flex: 1,
    backgroundColor: colors.background.dark,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.md,
  },
  errorText: {
    color: colors.error,
    textAlign: 'center',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.sm,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flex: 1,
  },
  headerTitle: {
    color: colors.text.primary.dark,
    fontSize: 16,
    fontWeight: '600',
  },
  terminateButton: {
    width: 32,
    height: 32,
    borderRadius: borderRadius.full,
    backgroundColor: withAlpha(colors.error, '15'),
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabledButton: {
    opacity: 0.5,
  },
  // Media Card
  mediaCard: {
    flexDirection: 'row',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border.dark,
    borderRadius: borderRadius.lg,
    padding: spacing.sm,
  },
  poster: {
    width: 56,
    height: 80,
    borderRadius: borderRadius.md,
    backgroundColor: colors.surface.dark,
  },
  mediaInfo: {
    flex: 1,
    minWidth: 0,
  },
  mediaTypeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  mediaTypeText: {
    color: colors.text.muted.dark,
    fontSize: 11,
  },
  mediaTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  mediaTitle: {
    color: colors.text.primary.dark,
    fontSize: 15,
    fontWeight: '500',
    flex: 1,
  },
  mediaSubtitle: {
    color: colors.text.muted.dark,
    fontSize: 13,
    marginTop: 2,
  },
  progressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  progressBar: {
    flex: 1,
    height: 6,
    backgroundColor: colors.border.dark,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.cyan.core,
    borderRadius: 3,
  },
  progressText: {
    color: colors.text.muted.dark,
    fontSize: 11,
    width: 32,
  },
  // User Card
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border.dark,
    borderRadius: borderRadius.lg,
    padding: spacing.sm,
  },
  userInfo: {
    flex: 1,
    minWidth: 0,
  },
  userName: {
    color: colors.text.primary.dark,
    fontSize: 15,
    fontWeight: '500',
  },
  userUsername: {
    color: colors.text.muted.dark,
    fontSize: 12,
  },
  // Section
  section: {
    borderWidth: 1,
    borderColor: colors.border.dark,
    borderRadius: borderRadius.lg,
    padding: spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  sectionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  sectionIconContainer: {
    width: 24,
    height: 24,
    borderRadius: borderRadius.full,
    backgroundColor: withAlpha(colors.cyan.core, '15'),
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionTitle: {
    color: colors.text.primary.dark,
    fontSize: 14,
    fontWeight: '500',
  },
  infoContent: {
    gap: spacing.xs,
  },
  // Info Row
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  infoLabel: {
    color: colors.text.muted.dark,
    fontSize: 13,
  },
  infoValueContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flex: 1,
    justifyContent: 'flex-end',
  },
  infoValue: {
    color: colors.text.primary.dark,
    fontSize: 13,
  },
  infoSubValue: {
    color: colors.text.muted.dark,
    fontSize: 11,
  },
  monoText: {
    fontFamily: 'monospace',
    fontSize: 11,
  },
  // Server Row
  serverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  serverLabel: {
    color: colors.text.muted.dark,
    fontSize: 13,
  },
  serverValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  serverType: {
    fontSize: 13,
    fontWeight: '500',
  },
  serverDot: {
    color: colors.text.muted.dark,
    fontSize: 13,
  },
  serverName: {
    color: colors.text.primary.dark,
    fontSize: 13,
  },
  // Location Row
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  locationText: {
    color: colors.text.primary.dark,
    fontSize: 13,
    flex: 1,
  },
  // Stream Badge
  streamBadgeContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  streamBadgeText: {
    color: colors.warning,
    fontSize: 11,
    fontWeight: '600',
  },
  streamBadgeTextSecondary: {
    color: colors.text.primary.dark,
    fontSize: 11,
    fontWeight: '600',
  },
  // Transcode Reason
  transcodeReasonCard: {
    backgroundColor: withAlpha(colors.warning, '10'),
    borderWidth: 1,
    borderColor: withAlpha(colors.warning, '30'),
    borderRadius: borderRadius.lg,
    padding: spacing.sm,
  },
  transcodeReasonLabel: {
    color: colors.warning,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  transcodeReasonText: {
    color: colors.text.primary.dark,
    fontSize: 12,
  },
  bottomPadding: {
    height: spacing.xl,
  },
});
