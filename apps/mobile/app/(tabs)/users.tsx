/**
 * Users tab - user list with infinite scroll
 * Query keys include selectedServerId for proper cache isolation per media server
 */
import { View, FlatList, RefreshControl, Pressable, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { api } from '@/lib/api';
import { useMediaServer } from '@/providers/MediaServerProvider';
import { Text } from '@/components/ui/text';
import { Card } from '@/components/ui/card';
import { UserAvatar } from '@/components/ui/user-avatar';
import { cn } from '@/lib/utils';
import { colors } from '@/lib/theme';
import type { ServerUserWithIdentity } from '@tracearr/shared';

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

function UserCard({ user, onPress }: { user: ServerUserWithIdentity; onPress: () => void }) {
  return (
    <Pressable onPress={onPress}>
      <Card className="mb-2 flex-row items-center justify-between p-3">
        <View className="flex-1 flex-row items-center gap-3">
          <UserAvatar thumbUrl={user.thumbUrl} username={user.username} size={48} />
          <View className="flex-1">
            <Text className="text-base font-semibold">{user.username}</Text>
            <Text className="text-muted-foreground mt-0.5 text-sm">
              {user.role === 'owner' ? 'Owner' : 'User'}
            </Text>
          </View>
        </View>
        <TrustScoreBadge score={user.trustScore} />
      </Card>
    </Pressable>
  );
}

export default function UsersScreen() {
  const router = useRouter();
  const { selectedServerId } = useMediaServer();

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, refetch, isRefetching } =
    useInfiniteQuery({
      queryKey: ['users', selectedServerId],
      queryFn: ({ pageParam = 1 }) =>
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
    });

  // Flatten all pages into single array
  const users = data?.pages.flatMap((page) => page.data) || [];
  const total = data?.pages[0]?.total || 0;

  const handleEndReached = () => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  };

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background.dark }}
      edges={['left', 'right', 'bottom']}
    >
      <FlatList
        data={users}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <UserCard user={item} onPress={() => router.push(`/user/${item.id}` as never)} />
        )}
        contentContainerClassName="p-4 pt-3"
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={colors.cyan.core}
          />
        }
        ListHeaderComponent={
          <View className="mb-3 flex-row items-center justify-between">
            <Text className="text-lg font-semibold">Users</Text>
            <Text className="text-muted-foreground text-sm">
              {total} {total === 1 ? 'user' : 'users'}
            </Text>
          </View>
        }
        ListFooterComponent={
          isFetchingNextPage ? (
            <View className="items-center py-4">
              <ActivityIndicator size="small" color={colors.cyan.core} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View className="items-center py-12">
            <View className="bg-card border-border mb-4 h-16 w-16 items-center justify-center rounded-full border">
              <Text className="text-muted-foreground text-2xl">0</Text>
            </View>
            <Text className="mb-1 text-lg font-semibold">No Users</Text>
            <Text className="text-muted-foreground px-4 text-center text-sm">
              Users will appear here after syncing with your media server
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}
