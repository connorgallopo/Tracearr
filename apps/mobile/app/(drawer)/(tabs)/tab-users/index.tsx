/**
 * Users tab - user list with infinite scroll
 * Query keys include selectedServerId for proper cache isolation per media server
 *
 * Responsive layout:
 * - Phone: Single column, compact cards
 * - Tablet (md+): 2-column grid, larger avatars, more info (crown, joined date), search bar
 */
import { useState, useMemo } from 'react';
import {
  View,
  FlatList,
  RefreshControl,
  Pressable,
  ActivityIndicator,
  TextInput,
  Platform,
} from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter, Stack } from 'expo-router';
import { DrawerActions, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api';
import { useMediaServer } from '@/providers/MediaServerProvider';
import { useResponsive } from '@/hooks/useResponsive';
import { useUnacknowledgedAlertsCount } from '@/hooks';
import { Text } from '@/components/ui/text';
import { Card } from '@/components/ui/card';
import { UserAvatar } from '@/components/ui/user-avatar';
import { cn } from '@/lib/utils';
import { colors, spacing, borderRadius, ACCENT_COLOR } from '@/lib/theme';
import type { ServerUserWithIdentity } from '@tracearr/shared';
import { useTranslation } from '@tracearr/translations/mobile';

const PAGE_SIZE = 50;

function TrustScoreBadge({ score }: { score: number }) {
  const variant = score < 50 ? 'destructive' : score < 75 ? 'warning' : 'success';

  return (
    <View
      className={cn(
        'min-w-[40px] items-center rounded-sm px-2 py-1',
        variant === 'destructive' && 'bg-destructive/20',
        variant === 'warning' && 'bg-warning/20',
        variant === 'success' && 'bg-success/20'
      )}
    >
      <Text
        className={cn(
          'text-sm font-semibold',
          variant === 'destructive' && 'text-destructive',
          variant === 'warning' && 'text-warning',
          variant === 'success' && 'text-success'
        )}
      >
        {score}
      </Text>
    </View>
  );
}

function UserCard({
  user,
  onPress,
  isTablet,
}: {
  user: ServerUserWithIdentity;
  onPress: () => void;
  isTablet?: boolean;
}) {
  const avatarSize = isTablet ? 56 : 48;
  const { t } = useTranslation(['mobile', 'common']);
  const displayName = user.identityName ?? user.username;
  const isOwner = user.role === 'owner';

  return (
    <Pressable onPress={onPress}>
      <Card className="mb-2 flex-row items-center justify-between p-3">
        <View className="flex-1 flex-row items-center gap-3">
          <UserAvatar
            thumbUrl={user.thumbUrl}
            serverId={user.serverId}
            username={user.username}
            size={avatarSize}
          />
          <View className="flex-1">
            <View className="flex-row items-center gap-1.5">
              <Text className="text-base font-semibold" numberOfLines={1}>
                {displayName}
              </Text>
              {isOwner && <Ionicons name="shield-checkmark" size={14} color={colors.warning} />}
            </View>
            {/* Show username if different from display name */}
            {user.identityName && user.identityName !== user.username && (
              <Text className="text-muted-foreground text-xs">@{user.username}</Text>
            )}
            {/* Tablet: show joined date */}
            {isTablet && user.createdAt && (
              <View className="mt-0.5 flex-row items-center gap-1">
                <Ionicons name="time-outline" size={10} color={colors.text.muted.dark} />
                <Text className="text-muted-foreground text-xs">
                  Joined {formatDistanceToNow(new Date(user.createdAt), { addSuffix: true })}
                </Text>
              </View>
            )}
            {/* Phone: show role text */}
            {!isTablet && !user.identityName && (
              <Text className="text-muted-foreground mt-0.5 text-sm">
                {isOwner ? t('mobile:users.owner') : t('common:labels.user')}
              </Text>
            )}
          </View>
        </View>
        <TrustScoreBadge score={user.trustScore} />
      </Card>
    </Pressable>
  );
}

export default function UsersScreen() {
  const { t } = useTranslation(['mobile', 'common']);
  const router = useRouter();
  const navigation = useNavigation();
  const { selectedServerId } = useMediaServer();
  const { isTablet, select } = useResponsive();
  const { hasAlerts, displayCount } = useUnacknowledgedAlertsCount();
  const [searchQuery, setSearchQuery] = useState('');

  // Responsive values
  const horizontalPadding = select({ base: spacing.md, md: spacing.lg, lg: spacing.xl });
  const numColumns = isTablet ? 2 : 1;

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, refetch, isRefetching } =
    useInfiniteQuery({
      queryKey: ['users', selectedServerId],
      queryFn: ({ pageParam }) =>
        api.users.list({
          page: pageParam,
          pageSize: PAGE_SIZE,
          serverId: selectedServerId ?? undefined,
        }),
      initialPageParam: 1,
      getNextPageParam: (lastPage: { page: number; totalPages: number }) => {
        if (lastPage.page < lastPage.totalPages) {
          return lastPage.page + 1;
        }
        return undefined;
      },
      staleTime: 1000 * 60, // 60 seconds - user list doesn't change frequently
    });

  // Flatten all pages into single array
  const allUsers = data?.pages.flatMap((page) => page.data) || [];
  const total = data?.pages[0]?.total || 0;

  // Filter users based on search query (client-side for now)
  const users = useMemo(() => {
    if (!searchQuery.trim()) return allUsers;
    const query = searchQuery.toLowerCase();
    return allUsers.filter(
      (user) =>
        user.username.toLowerCase().includes(query) ||
        user.identityName?.toLowerCase().includes(query)
    );
  }, [allUsers, searchQuery]);

  const handleEndReached = () => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  };

  return (
    <>
      <FlatList
        data={users}
        keyExtractor={(item) => item.id}
        numColumns={numColumns}
        key={numColumns} // Force re-render when columns change
        contentInsetAdjustmentBehavior="automatic"
        renderItem={({ item, index }) => (
          <View
            style={{
              flex: 1,
              paddingLeft: isTablet && index % 2 === 1 ? spacing.sm / 2 : 0,
              paddingRight: isTablet && index % 2 === 0 ? spacing.sm / 2 : 0,
            }}
          >
            <UserCard
              user={item}
              onPress={() => router.push(`/user/${item.id}` as never)}
              isTablet={isTablet}
            />
          </View>
        )}
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingTop: spacing.sm,
          paddingBottom: spacing.xl,
        }}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={ACCENT_COLOR} />
        }
        ListHeaderComponent={
          <View style={{ marginBottom: spacing.md }}>
            {/* Title row */}
            <View className="mb-3 flex-row items-center justify-between">
              <Text className="text-muted-foreground text-sm">
                {searchQuery ? `${users.length} of ${total}` : total}{' '}
                {t('common:count.user', { count: total })}
              </Text>
            </View>
            {/* Search bar - tablet only */}
            {isTablet && (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: colors.card.dark,
                  borderRadius: borderRadius.lg,
                  paddingHorizontal: spacing.md,
                  paddingVertical: spacing.sm,
                  borderWidth: 1,
                  borderColor: colors.border.dark,
                }}
              >
                <Ionicons name="search" size={18} color={colors.text.muted.dark} />
                <TextInput
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder={t('common:search.searchUsers')}
                  placeholderTextColor={colors.text.muted.dark}
                  style={{
                    flex: 1,
                    marginLeft: spacing.sm,
                    color: colors.text.primary.dark,
                    fontSize: 14,
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {searchQuery.length > 0 && (
                  <Pressable onPress={() => setSearchQuery('')}>
                    <Ionicons name="close-circle" size={18} color={colors.text.muted.dark} />
                  </Pressable>
                )}
              </View>
            )}
          </View>
        }
        ListFooterComponent={
          isFetchingNextPage ? (
            <View className="items-center py-4">
              <ActivityIndicator size="small" color={ACCENT_COLOR} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View className="items-center py-12">
            <View className="bg-card border-border mb-4 h-16 w-16 items-center justify-center rounded-full border">
              <Ionicons name="people-outline" size={32} color={colors.text.muted.dark} />
            </View>
            <Text className="mb-1 text-lg font-semibold">
              {searchQuery ? t('common:empty.noResults') : t('mobile:users.noUsers')}
            </Text>
            <Text className="text-muted-foreground px-4 text-center text-sm">
              {searchQuery
                ? t('mobile:users.noUsersMatch', { query: searchQuery })
                : t('mobile:users.usersWillAppear')}
            </Text>
          </View>
        }
      />

      {/* iOS Native Toolbar */}
      {Platform.OS === 'ios' && (
        <>
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button
              icon="line.3.horizontal"
              onPress={() => navigation.dispatch(DrawerActions.openDrawer())}
            />
          </Stack.Toolbar>
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button icon="bell" onPress={() => router.push('/alerts')}>
              {hasAlerts && <Stack.Toolbar.Badge>{displayCount}</Stack.Toolbar.Badge>}
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
        </>
      )}
    </>
  );
}
