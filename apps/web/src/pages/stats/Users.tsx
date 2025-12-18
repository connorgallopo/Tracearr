import { Users as UsersIcon, Trophy } from 'lucide-react';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { UserCard, UserRow } from '@/components/users';
import { Skeleton } from '@/components/ui/skeleton';
import { useTopUsers } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';

export function StatsUsers() {
  const { value: timeRange, setValue: setTimeRange, apiParams } = useTimeRange();
  const { selectedServerId } = useServer();
  const topUsers = useTopUsers(apiParams, selectedServerId);

  const users = topUsers.data ?? [];
  const podiumUsers = users.slice(0, 3);
  const listUsers = users.slice(3);

  // Create a stable key for animations based on the time range
  const rangeKey =
    timeRange.period === 'custom'
      ? `custom-${timeRange.startDate?.toISOString()}-${timeRange.endDate?.toISOString()}`
      : timeRange.period;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-end">
        <TimeRangePicker value={timeRange} onChange={setTimeRange} />
      </div>

      {topUsers.isLoading ? (
        <div className="space-y-8">
          {/* Podium skeleton */}
          <section>
            <div className="mb-4 flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded" />
              <Skeleton className="h-6 w-24" />
            </div>
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-end sm:justify-center">
              <Skeleton className="h-56 w-40 rounded-xl" />
              <Skeleton className="h-64 w-44 rounded-xl" />
              <Skeleton className="h-56 w-40 rounded-xl" />
            </div>
          </section>
          {/* List skeleton */}
          <section>
            <div className="mb-4 flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded" />
              <Skeleton className="h-6 w-32" />
            </div>
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          </section>
        </div>
      ) : users.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <UsersIcon className="text-muted-foreground/50 mx-auto h-16 w-16" />
          <h3 className="mt-4 text-lg font-semibold">No activity yet</h3>
          <p className="text-muted-foreground mt-1">Start streaming to see your top users here</p>
        </div>
      ) : (
        <>
          {/* Podium Section - Top 3 */}
          <section>
            <div className="mb-4 flex items-center gap-2">
              <Trophy className="text-primary h-5 w-5" />
              <h2 className="text-lg font-semibold">Top 3</h2>
            </div>

            {/* Key prop forces re-render on period change for animations */}
            <div
              key={`podium-${rangeKey}`}
              className="flex flex-col items-center gap-4 sm:flex-row sm:items-end sm:justify-center"
            >
              {/* #2 - Left (shown second on mobile, left on desktop) */}
              {podiumUsers[1] && (
                <div className="order-2 sm:order-1">
                  <UserCard
                    userId={podiumUsers[1].serverUserId}
                    username={podiumUsers[1].username}
                    identityName={podiumUsers[1].identityName}
                    thumbUrl={podiumUsers[1].thumbUrl}
                    serverId={podiumUsers[1].serverId}
                    trustScore={podiumUsers[1].trustScore}
                    playCount={podiumUsers[1].playCount}
                    watchTimeHours={podiumUsers[1].watchTimeHours}
                    topContent={podiumUsers[1].topContent}
                    rank={2}
                    className="w-44"
                  />
                </div>
              )}

              {/* #1 - Center (shown first on mobile, center on desktop) */}
              {podiumUsers[0] && (
                <div className="order-1 sm:order-2">
                  <UserCard
                    userId={podiumUsers[0].serverUserId}
                    username={podiumUsers[0].username}
                    identityName={podiumUsers[0].identityName}
                    thumbUrl={podiumUsers[0].thumbUrl}
                    serverId={podiumUsers[0].serverId}
                    trustScore={podiumUsers[0].trustScore}
                    playCount={podiumUsers[0].playCount}
                    watchTimeHours={podiumUsers[0].watchTimeHours}
                    topContent={podiumUsers[0].topContent}
                    rank={1}
                    className="w-48 sm:scale-105"
                  />
                </div>
              )}

              {/* #3 - Right (shown third on mobile, right on desktop) */}
              {podiumUsers[2] && (
                <div className="order-3">
                  <UserCard
                    userId={podiumUsers[2].serverUserId}
                    username={podiumUsers[2].username}
                    identityName={podiumUsers[2].identityName}
                    thumbUrl={podiumUsers[2].thumbUrl}
                    serverId={podiumUsers[2].serverId}
                    trustScore={podiumUsers[2].trustScore}
                    playCount={podiumUsers[2].playCount}
                    watchTimeHours={podiumUsers[2].watchTimeHours}
                    topContent={podiumUsers[2].topContent}
                    rank={3}
                    className="w-44"
                  />
                </div>
              )}
            </div>
          </section>

          {/* List Section - #4 onwards */}
          {listUsers.length > 0 && (
            <section>
              <div className="mb-4 flex items-center gap-2">
                <UsersIcon className="text-primary h-5 w-5" />
                <h2 className="text-lg font-semibold">Runners Up</h2>
              </div>

              {/* Key prop forces re-render on period change for animations */}
              <div key={`list-${rangeKey}`} className="space-y-2">
                {listUsers.map((user, index: number) => (
                  <UserRow
                    key={user.serverUserId}
                    userId={user.serverUserId}
                    username={user.username}
                    identityName={user.identityName}
                    thumbUrl={user.thumbUrl}
                    serverId={user.serverId}
                    trustScore={user.trustScore}
                    playCount={user.playCount}
                    watchTimeHours={user.watchTimeHours}
                    topContent={user.topContent}
                    rank={index + 4}
                    style={{ animationDelay: `${index * 50}ms` }}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
