/**
 * Session detail screen
 * Shows comprehensive information about a specific session/stream
 * Query keys include selectedServerId for proper cache isolation per media server
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { View, Text, ScrollView, Pressable, ActivityIndicator, Image, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useState, useEffect } from 'react';
import {
  Play,
  Pause,
  Square,
  User,
  Server,
  MapPin,
  Smartphone,
  Clock,
  Gauge,
  Tv,
  Film,
  Music,
  Zap,
  Globe,
  Wifi,
  X,
} from 'lucide-react-native';
import { api, getServerUrl } from '@/lib/api';
import { useMediaServer } from '@/providers/MediaServerProvider';
import { colors } from '@/lib/theme';
import { Badge } from '@/components/ui/badge';
import type { SessionWithDetails, SessionState, MediaType } from '@tracearr/shared';

// Safe date parsing helper - handles string dates from API
function safeParseDate(date: Date | string | null | undefined): Date | null {
  if (!date) return null;
  const parsed = new Date(date);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// Safe format date helper
function safeFormatDate(date: Date | string | null | undefined, formatStr: string): string {
  const parsed = safeParseDate(date);
  if (!parsed) return 'Unknown';
  return format(parsed, formatStr);
}

// Get state icon, color, and badge variant
function getStateInfo(
  state: SessionState,
  watched?: boolean
): {
  icon: typeof Play;
  color: string;
  label: string;
  variant: 'success' | 'warning' | 'secondary';
} {
  // Show "Watched" for completed sessions where user watched 80%+
  if (watched && state === 'stopped') {
    return { icon: Play, color: colors.success, label: 'Watched', variant: 'success' };
  }
  switch (state) {
    case 'playing':
      return { icon: Play, color: colors.success, label: 'Playing', variant: 'success' };
    case 'paused':
      return { icon: Pause, color: colors.warning, label: 'Paused', variant: 'warning' };
    case 'stopped':
      return {
        icon: Square,
        color: colors.text.secondary.dark,
        label: 'Stopped',
        variant: 'secondary',
      };
    default:
      return {
        icon: Square,
        color: colors.text.secondary.dark,
        label: 'Unknown',
        variant: 'secondary',
      };
  }
}

// Get media type icon
function getMediaIcon(mediaType: MediaType): typeof Film {
  switch (mediaType) {
    case 'movie':
      return Film;
    case 'episode':
      return Tv;
    case 'track':
      return Music;
    default:
      return Film;
  }
}

// Format duration
function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

// Format bitrate
function formatBitrate(bitrate: number | null): string {
  if (bitrate === null) return '-';
  if (bitrate >= 1000) {
    return `${(bitrate / 1000).toFixed(1)} Mbps`;
  }
  return `${bitrate} Kbps`;
}

// Info card component
function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="bg-card mb-4 rounded-xl p-4">
      <Text className="text-muted-foreground mb-3 text-sm font-medium">{title}</Text>
      {children}
    </View>
  );
}

// Info row component
function InfoRow({
  icon: Icon,
  label,
  value,
  valueColor,
}: {
  icon: typeof Play;
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View className="border-border flex-row items-center border-b py-2 last:border-b-0">
      <Icon size={18} color={colors.text.secondary.dark} />
      <Text className="text-muted-foreground ml-3 flex-1 text-sm">{label}</Text>
      <Text
        className="text-sm font-medium"
        style={{ color: valueColor || colors.text.primary.dark }}
      >
        {value}
      </Text>
    </View>
  );
}

// Progress bar component
function ProgressBar({ progress, total }: { progress: number | null; total: number | null }) {
  if (progress === null || total === null || total === 0) {
    return null;
  }

  const percentage = Math.min((progress / total) * 100, 100);

  return (
    <View style={{ marginTop: 12 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={{ color: colors.text.secondary.dark, fontSize: 12 }}>
          {formatDuration(progress)}
        </Text>
        <Text style={{ color: colors.text.secondary.dark, fontSize: 12 }}>
          {formatDuration(total)}
        </Text>
      </View>
      <View style={{ backgroundColor: '#27272a', height: 8, borderRadius: 4, overflow: 'hidden' }}>
        <View
          style={{
            backgroundColor: colors.cyan.core,
            height: '100%',
            borderRadius: 4,
            width: `${percentage}%`,
          }}
        />
      </View>
      <Text style={{ color: '#71717a', fontSize: 12, textAlign: 'center', marginTop: 4 }}>
        {percentage.toFixed(1)}% watched
      </Text>
    </View>
  );
}

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { selectedServerId } = useMediaServer();
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  // Load server URL for image paths
  useEffect(() => {
    void getServerUrl().then(setServerUrl);
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

  // Handle terminate button press
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
    queryFn: async () => {
      console.log('[SessionDetail] Fetching session:', id);
      try {
        const result = await api.sessions.get(id);
        console.log('[SessionDetail] Received session data:', JSON.stringify(result, null, 2));
        return result;
      } catch (err) {
        console.error('[SessionDetail] API error:', err);
        throw err;
      }
    },
    enabled: !!id,
  });

  // Debug logging
  useEffect(() => {
    console.log('[SessionDetail] State:', {
      id,
      isLoading,
      hasError: !!error,
      hasSession: !!session,
    });
    if (error) {
      console.error('[SessionDetail] Query error:', error);
    }
    if (session) {
      console.log('[SessionDetail] Session fields:', {
        id: session.id,
        username: session.user.username,
        mediaTitle: session.mediaTitle,
        state: session.state,
      });
    }
  }, [id, isLoading, error, session]);

  if (isLoading) {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: colors.background.dark,
          justifyContent: 'center',
          alignItems: 'center',
        }}
        edges={['left', 'right', 'bottom']}
      >
        <ActivityIndicator size="large" color={colors.cyan.core} />
      </SafeAreaView>
    );
  }

  if (error || !session) {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: colors.background.dark,
          justifyContent: 'center',
          alignItems: 'center',
          padding: 16,
        }}
        edges={['left', 'right', 'bottom']}
      >
        <Text style={{ color: '#f87171', textAlign: 'center' }}>
          {error instanceof Error ? error.message : 'Failed to load session'}
        </Text>
      </SafeAreaView>
    );
  }

  const stateInfo = getStateInfo(session.state, session.watched);
  const MediaIcon = getMediaIcon(session.mediaType);

  // Format media title with episode info
  const getMediaTitle = (): string => {
    if (session.mediaType === 'episode' && session.grandparentTitle) {
      const episodeInfo =
        session.seasonNumber && session.episodeNumber
          ? `S${session.seasonNumber}E${session.episodeNumber}`
          : '';
      return `${session.grandparentTitle}${episodeInfo ? ` • ${episodeInfo}` : ''}`;
    }
    return session.mediaTitle;
  };

  const getSubtitle = (): string => {
    if (session.mediaType === 'episode') {
      return session.mediaTitle; // Episode title
    }
    if (session.year) {
      return String(session.year);
    }
    return '';
  };

  // Get location string
  const getLocation = (): string => {
    const parts = [session.geoCity, session.geoRegion, session.geoCountry].filter(Boolean);
    return parts.join(', ') || 'Unknown';
  };

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background.dark }}
      edges={['left', 'right', 'bottom']}
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        {/* Media Header */}
        <View className="bg-card mb-4 rounded-xl p-4">
          {/* Terminate button - top right */}
          <View className="absolute top-2 right-2 z-10">
            <Pressable
              onPress={handleTerminate}
              disabled={terminateMutation.isPending}
              className="bg-destructive/10 h-8 w-8 items-center justify-center rounded-full active:opacity-70"
              style={{ opacity: terminateMutation.isPending ? 0.5 : 1 }}
            >
              <X size={18} color="#ef4444" />
            </Pressable>
          </View>

          <View className="flex-row items-start">
            {/* Poster/Thumbnail */}
            <View className="bg-surface mr-4 h-28 w-20 overflow-hidden rounded-lg">
              {session.thumbPath && serverUrl ? (
                <Image
                  source={{
                    uri: `${serverUrl}/api/v1/images/proxy?server=${session.serverId}&url=${encodeURIComponent(session.thumbPath)}&width=160&height=224`,
                  }}
                  style={{ width: '100%', height: '100%' }}
                  resizeMode="cover"
                />
              ) : (
                <View className="h-full w-full items-center justify-center">
                  <MediaIcon size={32} color={colors.text.secondary.dark} />
                </View>
              )}
            </View>

            {/* Media Info */}
            <View className="flex-1">
              <View className="mb-2 flex-row items-center">
                <Badge variant={stateInfo.variant}>{stateInfo.label}</Badge>
              </View>

              <Text className="text-lg font-semibold text-white" numberOfLines={2}>
                {getMediaTitle()}
              </Text>

              {getSubtitle() ? (
                <Text className="text-muted-foreground mt-1 text-sm" numberOfLines={1}>
                  {getSubtitle()}
                </Text>
              ) : null}

              <View className="mt-2 flex-row items-center">
                <MediaIcon size={14} color={colors.text.secondary.dark} />
                <Text className="text-muted-foreground ml-1 text-xs capitalize">
                  {session.mediaType}
                </Text>
              </View>
            </View>
          </View>

          {/* Progress bar */}
          <ProgressBar progress={session.progressMs} total={session.totalDurationMs} />
        </View>

        {/* User Card - Tappable */}
        <Pressable
          onPress={() => router.push(`/user/${session.serverUserId}` as never)}
          className="bg-card mb-4 rounded-xl p-4 active:opacity-70"
        >
          <Text className="text-muted-foreground mb-3 text-sm font-medium">User</Text>
          <View className="flex-row items-center">
            <View className="bg-surface h-12 w-12 overflow-hidden rounded-full">
              {session.user.thumbUrl ? (
                <Image
                  source={{ uri: session.user.thumbUrl }}
                  className="h-full w-full"
                  resizeMode="cover"
                />
              ) : (
                <View className="h-full w-full items-center justify-center">
                  <User size={24} color={colors.text.secondary.dark} />
                </View>
              )}
            </View>
            <View className="ml-3 flex-1">
              <Text className="text-foreground text-base font-semibold">
                {session.user.identityName ?? session.user.username}
              </Text>
              <Text className="text-muted-foreground text-sm">Tap to view profile</Text>
            </View>
            <Text className="text-primary text-sm">→</Text>
          </View>
        </Pressable>

        {/* Server Info */}
        <InfoCard title="Server">
          <View className="flex-row items-center">
            <Server size={20} color={colors.text.secondary.dark} />
            <View className="ml-3 flex-1">
              <Text className="text-foreground text-base font-medium">{session.server.name}</Text>
              <Text className="text-muted-foreground text-sm capitalize">
                {session.server.type}
              </Text>
            </View>
          </View>
        </InfoCard>

        {/* Timing Info */}
        <InfoCard title="Timing">
          <InfoRow
            icon={Clock}
            label="Started"
            value={safeFormatDate(session.startedAt, 'MMM d, yyyy h:mm a')}
          />
          {session.stoppedAt && (
            <InfoRow
              icon={Square}
              label="Stopped"
              value={safeFormatDate(session.stoppedAt, 'MMM d, yyyy h:mm a')}
            />
          )}
          <InfoRow icon={Play} label="Watch Time" value={formatDuration(session.durationMs)} />
          {(session.pausedDurationMs ?? 0) > 0 && (
            <InfoRow
              icon={Pause}
              label="Paused Time"
              value={formatDuration(session.pausedDurationMs)}
            />
          )}
        </InfoCard>

        {/* Location Info */}
        <InfoCard title="Location">
          <InfoRow icon={Globe} label="IP Address" value={session.ipAddress || 'Unknown'} />
          <InfoRow icon={MapPin} label="Location" value={getLocation()} />
          {session.geoLat && session.geoLon && (
            <InfoRow
              icon={MapPin}
              label="Coordinates"
              value={`${session.geoLat.toFixed(4)}, ${session.geoLon.toFixed(4)}`}
            />
          )}
        </InfoCard>

        {/* Device Info */}
        <InfoCard title="Device">
          <InfoRow icon={Smartphone} label="Player" value={session.playerName || 'Unknown'} />
          <InfoRow icon={Tv} label="Device" value={session.device || 'Unknown'} />
          <InfoRow icon={Wifi} label="Platform" value={session.platform || 'Unknown'} />
          {session.product && <InfoRow icon={Smartphone} label="Product" value={session.product} />}
        </InfoCard>

        {/* Quality Info */}
        <InfoCard title="Quality">
          <InfoRow icon={Gauge} label="Quality" value={session.quality || 'Unknown'} />
          <InfoRow
            icon={Zap}
            label="Stream"
            value={
              session.isTranscode
                ? 'Transcode'
                : session.videoDecision === 'copy' || session.audioDecision === 'copy'
                  ? 'Direct Stream'
                  : 'Direct Play'
            }
            valueColor={session.isTranscode ? colors.warning : colors.success}
          />
          {session.videoDecision && (
            <InfoRow
              icon={Film}
              label="Video"
              value={
                session.videoDecision === 'directplay'
                  ? 'Direct Play'
                  : session.videoDecision === 'copy'
                    ? 'Direct Stream'
                    : 'Transcode'
              }
            />
          )}
          {session.audioDecision && (
            <InfoRow
              icon={Music}
              label="Audio"
              value={
                session.audioDecision === 'directplay'
                  ? 'Direct Play'
                  : session.audioDecision === 'copy'
                    ? 'Direct Stream'
                    : 'Transcode'
              }
            />
          )}
          {session.bitrate && (
            <InfoRow icon={Gauge} label="Bitrate" value={formatBitrate(session.bitrate)} />
          )}
        </InfoCard>

        {/* Bottom padding */}
        <View className="h-8" />
      </ScrollView>
    </SafeAreaView>
  );
}
