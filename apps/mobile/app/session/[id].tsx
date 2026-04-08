/**
 * Session detail screen
 * Shows comprehensive information about a specific session/stream
 * Matches the design of web/src/components/history/SessionDetailSheet.tsx
 */
import { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  View,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Image,
  Alert,
  Modal,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
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
  Zap,
  Cpu,
  Eye,
  ChevronRight,
  X,
  Clapperboard,
} from 'lucide-react-native';
import { api, getServerUrl } from '@/lib/api';
import { useMediaServer } from '@/providers/MediaServerProvider';
import { useAuthStateStore } from '@/lib/authStateStore';
import { colors, withAlpha, ACCENT_COLOR } from '@/lib/theme';
import { Text } from '@/components/ui/text';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/ui/user-avatar';
import { StreamDetailsPanel } from '@/components/session';
import type { SessionWithDetails, SessionState, MediaType, ServerType } from '@tracearr/shared';
import { useTranslation } from '@tracearr/translations/mobile';

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

function getWatchTime(session: SessionWithDetails): number | null {
  if (session.durationMs) {
    return session.durationMs;
  }

  if (session.startedAt && !session.stoppedAt) {
    const startTime = safeParseDate(session.startedAt)?.getTime();
    if (!startTime) return null;
    return Math.max(0, Date.now() - startTime - (session.pausedDurationMs ?? 0));
  }

  return null;
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
    <View className="border-border rounded-xl border p-2">
      <View className="mb-2 flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <View className="bg-primary/15 h-6 w-6 items-center justify-center rounded-full">
            <Icon size={14} color={ACCENT_COLOR} />
          </View>
          <Text className="text-foreground text-sm font-medium">{title}</Text>
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
    <View className="flex-row items-center justify-between">
      <Text className="text-muted-foreground text-[13px]">{label}</Text>
      <View className="flex-1 flex-row items-center justify-end gap-1">
        <Text
          className={`text-[13px] font-medium ${mono ? 'font-mono text-[11px]' : ''}`}
          style={{ color: valueColor ?? '#FAFAFA' }}
          numberOfLines={1}
        >
          {value}
        </Text>
        {subValue && <Text className="text-muted-foreground text-[11px]">{subValue}</Text>}
      </View>
    </View>
  );
}

export default function SessionDetailScreen() {
  const { t } = useTranslation(['mobile', 'common', 'pages']);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { selectedServerId } = useMediaServer();
  const connectionState = useAuthStateStore((s) => s.connectionState);
  const isOffline = connectionState !== 'connected';
  const serverUrl = getServerUrl();

  // Terminate session state and mutation
  const [terminateModalVisible, setTerminateModalVisible] = useState(false);
  const [terminateReason, setTerminateReason] = useState('');

  const terminateMutation = useMutation({
    mutationFn: ({ sessionId, reason }: { sessionId: string; reason?: string }) =>
      api.sessions.terminate(sessionId, reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'active'] });
      setTerminateModalVisible(false);
      setTerminateReason('');
      Alert.alert(t('mobile:session.streamTerminated'), t('mobile:session.sessionStopped'));
      router.back();
    },
    onError: (error: Error) => {
      Alert.alert(t('mobile:session.failedToTerminate'), error.message);
    },
  });

  const handleTerminate = () => {
    setTerminateReason('');
    setTerminateModalVisible(true);
  };

  const handleConfirmTerminate = () => {
    terminateMutation.mutate({ sessionId: id, reason: terminateReason.trim() || undefined });
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
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: '#09090B',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        edges={['left', 'right', 'bottom']}
      >
        <ActivityIndicator size="large" color={ACCENT_COLOR} />
      </SafeAreaView>
    );
  }

  if (error || !session) {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: '#09090B',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 12,
        }}
        edges={['left', 'right', 'bottom']}
      >
        <Text className="text-destructive text-center">
          {error instanceof Error ? error.message : t('mobile:errors.failedToLoadSession')}
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
    <>
      <SafeAreaView
        style={{ flex: 1, backgroundColor: '#09090B' }}
        edges={['left', 'right', 'bottom']}
      >
        <ScrollView style={{ flex: 1 }} contentContainerClassName="gap-2 p-3">
          {/* Header with state badge and terminate button */}
          <View className="flex-row items-center justify-between pb-2">
            <View className="flex-1 flex-row items-center gap-2">
              <StateIcon size={16} color={stateConfig.color} />
              <Text className="text-foreground text-base font-semibold">
                {t('common:labels.sessionDetails')}
              </Text>
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
                disabled={terminateMutation.isPending || isOffline}
                className={`h-8 w-8 items-center justify-center rounded-full ${terminateMutation.isPending || isOffline ? 'opacity-50' : ''}`}
                style={{ backgroundColor: withAlpha(colors.error, '15') }}
              >
                <X size={18} color={colors.error} />
              </Pressable>
            )}
          </View>

          {/* Media Info - Hero section */}
          <View className="border-border flex-row gap-2 rounded-xl border p-2">
            {posterUrl && (
              <Image
                source={{ uri: posterUrl }}
                className="bg-surface rounded-lg"
                style={{ width: 56, height: 80 }}
                resizeMode="cover"
              />
            )}
            <View className="min-w-0 flex-1">
              <View className="mb-1 flex-row items-center gap-1">
                <MediaIcon size={12} color={colors.text.muted.dark} />
                <Text className="text-muted-foreground text-[11px]">{mediaConfig.label}</Text>
                {session.year && (
                  <Text className="text-muted-foreground text-[11px]">· {session.year}</Text>
                )}
              </View>
              <View className="flex-row items-center gap-1">
                <Text className="text-foreground flex-1 text-[15px] font-medium" numberOfLines={2}>
                  {title.primary}
                </Text>
                {session.watched && <Eye size={14} color={colors.success} />}
              </View>
              {title.secondary && (
                <Text className="text-muted-foreground mt-0.5 text-[13px]" numberOfLines={1}>
                  {title.secondary}
                </Text>
              )}
              {/* Progress inline */}
              <View className="mt-2 flex-row items-center gap-2">
                <View className="bg-border h-1.5 flex-1 overflow-hidden rounded-sm">
                  <View
                    className="bg-primary h-full rounded-sm"
                    style={{ width: `${progress}%` }}
                  />
                </View>
                <Text className="text-muted-foreground w-8 text-[11px]">{progress}%</Text>
              </View>
            </View>
          </View>

          {/* User - Tappable */}
          <Pressable
            className="border-border flex-row items-center gap-2 rounded-xl border p-2"
            onPress={() => router.push(`/user/${session.serverUserId}` as never)}
          >
            <UserAvatar
              thumbUrl={session.user.thumbUrl}
              serverId={session.serverId}
              username={session.user.username}
              size={36}
            />
            <View className="min-w-0 flex-1">
              <Text className="text-foreground text-[15px] font-medium" numberOfLines={1}>
                {session.user.identityName ?? session.user.username}
              </Text>
              {session.user.identityName && session.user.identityName !== session.user.username && (
                <Text className="text-muted-foreground text-xs">@{session.user.username}</Text>
              )}
              {!session.user.identityName && (
                <Text className="text-muted-foreground text-xs">
                  {t('common:actions.viewProfile')}
                </Text>
              )}
            </View>
            <ChevronRight size={16} color={colors.text.muted.dark} />
          </Pressable>

          {/* Server */}
          <Section icon={Server} title={t('common:labels.server')}>
            <View className="flex-row items-center justify-between">
              <Text className="text-muted-foreground text-[13px]">Server</Text>
              <View className="flex-row items-center gap-1">
                <Text className="text-[13px] font-medium" style={{ color: serverConfig.color }}>
                  {serverConfig.label}
                </Text>
                <Text className="text-muted-foreground text-[13px]">·</Text>
                <Text className="text-[13px] font-medium" style={{ color: '#FAFAFA' }}>
                  {session.server.name}
                </Text>
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
            <View className="gap-1">
              {startedAt && (
                <InfoRow
                  label={t('common:labels.started')}
                  value={format(startedAt, 'MMM d, h:mm a')}
                  subValue={formatDistanceToNow(startedAt, { addSuffix: true })}
                />
              )}
              {stoppedAt && (
                <InfoRow
                  label={t('common:labels.stopped')}
                  value={format(stoppedAt, 'MMM d, h:mm a')}
                />
              )}
              <InfoRow
                label={t('common:labels.watchTime')}
                value={formatDuration(getWatchTime(session))}
              />
              {session.pausedDurationMs > 0 && (
                <InfoRow
                  label={t('common:labels.pausedTime')}
                  value={formatDuration(session.pausedDurationMs)}
                />
              )}
              {session.totalDurationMs && (
                <InfoRow
                  label={t('common:labels.mediaLength')}
                  value={formatDuration(session.totalDurationMs)}
                />
              )}
            </View>
          </Section>

          {/* Location & Network */}
          <Section icon={MapPin} title="Location">
            <View className="gap-1">
              <InfoRow label={t('common:labels.ipAddress')} value={session.ipAddress || '—'} mono />
              {locationString && (
                <View className="flex-row items-center gap-1">
                  <Globe size={14} color={colors.text.muted.dark} />
                  <Text className="flex-1 text-[13px] font-medium" style={{ color: '#FAFAFA' }}>
                    {locationString}
                  </Text>
                </View>
              )}
            </View>
          </Section>

          {/* Device */}
          <Section icon={Smartphone} title={t('common:labels.device')}>
            <View className="gap-1">
              {session.platform && (
                <InfoRow label={t('common:labels.platform')} value={session.platform} />
              )}
              {session.product && (
                <InfoRow label={t('common:labels.product')} value={session.product} />
              )}
              {session.device && (
                <InfoRow label={t('common:labels.device')} value={session.device} />
              )}
              {session.playerName && (
                <InfoRow label={t('common:labels.player')} value={session.playerName} />
              )}
              {session.deviceId && (
                <InfoRow label={t('common:labels.deviceId')} value={session.deviceId} mono />
              )}
            </View>
          </Section>

          {/* Stream Details */}
          <Section
            icon={Gauge}
            title={t('common:labels.streamDetails')}
            badge={(() => {
              const isHwTranscode =
                session.isTranscode &&
                !!(session.transcodeInfo?.hwEncoding || session.transcodeInfo?.hwDecoding);
              const TranscodeIcon = isHwTranscode ? Cpu : Zap;

              if (session.isTranscode) {
                return (
                  <Badge variant="warning">
                    <View className="flex-row items-center gap-1">
                      <TranscodeIcon size={12} color={colors.warning} />
                      <Text className="text-warning text-[11px] font-semibold">
                        {t('common:playback.transcode')}
                      </Text>
                    </View>
                  </Badge>
                );
              }

              return (
                <Badge variant="secondary">
                  <View className="flex-row items-center gap-1">
                    <MonitorPlay size={12} color={colors.text.primary.dark} />
                    <Text className="text-foreground text-[11px] font-semibold">
                      {session.videoDecision === 'copy' || session.audioDecision === 'copy'
                        ? t('common:playback.directStream')
                        : t('common:playback.directPlay')}
                    </Text>
                  </View>
                </Badge>
              );
            })()}
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
            <View
              className="rounded-xl border p-2"
              style={{
                backgroundColor: withAlpha(colors.warning, '10'),
                borderColor: withAlpha(colors.warning, '30'),
              }}
            >
              <Text className="text-warning mb-1 text-[11px] font-semibold">
                {t('common:labels.transcodeReason')}
              </Text>
              <Text className="text-xs font-medium" style={{ color: '#FAFAFA' }}>
                {transcodeReasonText}
              </Text>
            </View>
          )}

          {/* Bottom padding */}
          <View className="h-6" />
        </ScrollView>
      </SafeAreaView>

      {/* Terminate stream confirmation modal */}
      <Modal
        visible={terminateModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setTerminateModalVisible(false)}
      >
        <Pressable
          className="flex-1 items-center justify-center bg-black/60"
          onPress={() => setTerminateModalVisible(false)}
        >
          <Pressable
            className="w-4/5 max-w-sm overflow-hidden rounded-xl"
            style={{ backgroundColor: '#18181B' }}
            onPress={(e) => e.stopPropagation()}
          >
            <View className="px-4 pt-4 pb-2">
              <Text className="text-lg font-semibold text-white">
                {t('pages:terminateStream.title')}
              </Text>
              <Text className="mt-1 text-sm" style={{ color: colors.text.muted.dark }}>
                {t('pages:terminateStream.messageLabel')}
              </Text>
            </View>
            <View className="px-4 pb-3">
              <TextInput
                value={terminateReason}
                onChangeText={setTerminateReason}
                placeholder="e.g., Please don't share your account"
                placeholderTextColor={colors.text.muted.dark}
                className="rounded-lg border px-3 py-2.5 text-sm text-white"
                style={{ borderColor: colors.border.dark, backgroundColor: '#09090B' }}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleConfirmTerminate}
              />
            </View>
            <View className="flex-row border-t" style={{ borderColor: colors.border.dark }}>
              <Pressable
                className="flex-1 items-center py-3"
                onPress={() => setTerminateModalVisible(false)}
              >
                <Text className="text-sm font-medium" style={{ color: colors.text.muted.dark }}>
                  {t('common:actions.cancel')}
                </Text>
              </Pressable>
              <View style={{ width: 1, backgroundColor: colors.border.dark }} />
              <Pressable
                className="flex-1 items-center py-3"
                onPress={handleConfirmTerminate}
                disabled={terminateMutation.isPending}
              >
                <Text className="text-sm font-medium" style={{ color: colors.error }}>
                  {terminateMutation.isPending
                    ? t('pages:terminateStream.terminating')
                    : t('common:actions.terminate')}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
