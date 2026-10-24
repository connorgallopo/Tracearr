import { useCallback, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import type { SessionWithDetails } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SessionDetailSheet } from '@/components/history/SessionDetailSheet';
import { UserRequestsCard } from '@/components/requests/UserRequestsCard';
import { EditTrustScoreDialog } from '@/components/users/EditTrustScoreDialog';
import { EditUserIdentityDialog } from '@/components/users/EditUserIdentityDialog';
import { getPersonRemovedState } from '@/components/users/removedStatus';
import { applyUserDetailScope, getUserDetailScope } from '@/components/users/userDetailScope';
import { AccessTab } from '@/components/users/detail/AccessTab';
import { DOWNLOADS_PAGE_SIZE, DownloadsTab } from '@/components/users/detail/DownloadsTab';
import { OverviewTab } from '@/components/users/detail/OverviewTab';
import { SessionsTab } from '@/components/users/detail/SessionsTab';
import { UserDetailHeader } from '@/components/users/detail/UserDetailHeader';
import { UserRangeStatCards } from '@/components/users/detail/UserRangeStatCards';
import { ViolationsTab } from '@/components/users/detail/ViolationsTab';
import {
  useRequestsConfigured,
  useSplitServerUser,
  useUserDownloads,
  useUserFull,
  useUserRangeStats,
} from '@/hooks/queries';
import { useUserRequests } from '@/hooks/queries/useRequests';
import { useAuth } from '@/hooks/useAuth';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';
import { api } from '@/lib/api';

const TABS = ['overview', 'sessions', 'requests', 'violations', 'downloads', 'access'] as const;
type UserDetailTab = (typeof TABS)[number];

// Shares the requests card's first-page query, so the tab count costs no extra request.
const REQUESTS_FIRST_PAGE = { page: 1, pageSize: 5 } as const;

function TabCount({ count }: { count: number }) {
  return <span className="text-muted-foreground text-xs tabular-nums">{count}</span>;
}

export function UserDetail() {
  const { t } = useTranslation(['pages', 'common', 'nav']);
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedServerIds } = useServer();
  const { user: authUser } = useAuth();
  const isOwner = authUser?.role === 'owner';
  const splitMutation = useSplitServerUser();
  const { value: timeRange, setValue: setTimeRange, apiDayParams } = useTimeRange();

  const [isEditIdentityOpen, setIsEditIdentityOpen] = useState(false);
  const [trustEditTarget, setTrustEditTarget] = useState<{
    id: string;
    username: string;
    score: number;
  } | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionWithDetails | null>(null);
  const [splitTarget, setSplitTarget] = useState<{ id: string; username: string } | null>(null);

  // scope=<serverUserId> narrows the whole page to that one account, like a
  // normal (unmerged) detail view. Absent or scope=all shows the whole
  // person's combined data across every account the caller can access.
  const scopeParam = searchParams.get('scope');
  const {
    effectiveId = '',
    identityScope,
    isSpecificServerScope,
    isAllScope,
  } = getUserDetailScope(id, scopeParam);

  const requestedTab = searchParams.get('tab');
  const tabParam = TABS.find((tab) => tab === requestedTab) ?? 'overview';

  const handleScopeChange = useCallback(
    (value: string) => {
      setSearchParams(applyUserDetailScope(searchParams, value), { replace: true });
    },
    [searchParams, setSearchParams]
  );

  const handleTabChange = (tab: string) => {
    const next = new URLSearchParams(searchParams);
    if (tab === 'overview') next.delete('tab');
    else next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  const handleSessionClick = useCallback(async (session: SessionWithDetails) => {
    try {
      const full = await api.sessions.get(session.id, session.startedAt);
      setSelectedSession(full);
    } catch {
      setSelectedSession(session);
    }
  }, []);

  const { data: fullData, isLoading } = useUserFull(effectiveId, { scope: identityScope });
  const rangeStats = useUserRangeStats(
    effectiveId,
    // The stats route reads a custom end as a picked UTC day and adds the day itself
    { ...apiDayParams, scope: identityScope },
    selectedServerIds
  );
  const requests = useUserRequests(effectiveId, { scope: identityScope, ...REQUESTS_FIRST_PAGE });
  const requestsConfigured = useRequestsConfigured().data?.configured ?? false;
  const downloads = useUserDownloads(effectiveId, {
    page: 1,
    pageSize: DOWNLOADS_PAGE_SIZE,
    scope: identityScope,
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-40" />
        <div className="flex items-center gap-4">
          <Skeleton className="h-16 w-16 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
        </div>
        <UserRangeStatCards stats={undefined} isLoading />
      </div>
    );
  }

  if (!fullData) {
    return (
      <div className="space-y-6">
        <Link to="/users">
          <Button variant="ghost" size="sm">
            <ArrowLeft />
            {t('pages:userDetail.backToUsers')}
          </Button>
        </Link>
        <Card>
          <CardContent className="flex h-32 items-center justify-center">
            <p className="text-muted-foreground">{t('pages:userDetail.userNotFound')}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { user, identity } = fullData;
  const isMergedIdentity = identity.serverUsers.length > 1;
  // The server column only earns its place once the view spans more than one server.
  const showServer = isAllScope && isMergedIdentity;
  const removed = isSpecificServerScope
    ? user.removedAt
      ? { removed: true as const, removedAt: user.removedAt }
      : { removed: false as const }
    : getPersonRemovedState(identity.serverUsers);

  const requestsTotal = requests.data?.total ?? 0;
  const downloadsTotal = downloads.data?.total ?? 0;
  const tabs: { value: UserDetailTab; label: string; count?: number }[] = [
    { value: 'overview', label: t('nav:overview') },
    { value: 'sessions', label: t('common:labels.sessions'), count: fullData.sessions.total },
    ...(requestsConfigured || requestsTotal > 0
      ? [{ value: 'requests' as const, label: t('nav:requests'), count: requestsTotal }]
      : []),
    { value: 'violations', label: t('nav:violations'), count: fullData.violations.total },
    ...(downloadsTotal > 0
      ? [
          {
            value: 'downloads' as const,
            label: t('pages:userDetail.tabs.downloads'),
            count: downloadsTotal,
          },
        ]
      : []),
    ...(isOwner || isMergedIdentity
      ? [{ value: 'access' as const, label: t('pages:userDetail.tabs.access') }]
      : []),
  ];
  const activeTab = tabs.some((tab) => tab.value === tabParam) ? tabParam : 'overview';
  // Panels hold their own page numbers; a new scope starts them over.
  const panelKey = scopeParam ?? 'all';

  return (
    <div className="space-y-6">
      <UserDetailHeader
        detail={fullData}
        isOwner={isOwner}
        scopeParam={scopeParam}
        onScopeChange={handleScopeChange}
        isSpecificServerScope={isSpecificServerScope}
        removed={removed}
        timeRange={timeRange}
        onTimeRangeChange={setTimeRange}
        onEditIdentity={() => setIsEditIdentityOpen(true)}
        onAdjustTrust={() =>
          setTrustEditTarget({ id: user.id, username: user.username, score: user.trustScore })
        }
      />

      <UserRangeStatCards
        stats={rangeStats.data}
        isLoading={rangeStats.isLoading}
        error={rangeStats.error}
        onRetry={() => void rangeStats.refetch()}
      />

      <Tabs value={activeTab} onValueChange={handleTabChange} className="gap-6">
        <div className="border-b">
          <TabsList variant="line" className="-mb-px">
            {tabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
                {tab.count !== undefined && <TabCount count={tab.count} />}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="overview">
          <OverviewTab
            stats={rangeStats.data}
            isLoading={rangeStats.isLoading}
            period={timeRange.period}
            detail={fullData}
            showServer={showServer}
            onSessionClick={handleSessionClick}
            onShowSessions={() => handleTabChange('sessions')}
          />
        </TabsContent>
        <TabsContent value="sessions">
          <SessionsTab
            key={panelKey}
            userId={effectiveId}
            scope={identityScope}
            user={user}
            showServer={showServer}
            onSessionClick={handleSessionClick}
          />
        </TabsContent>
        <TabsContent value="requests">
          {requestsTotal > 0 ? (
            <UserRequestsCard serverUserId={effectiveId} scope={identityScope} />
          ) : (
            <p className="text-muted-foreground text-sm">{t('pages:requests.userCard.empty')}</p>
          )}
        </TabsContent>
        <TabsContent value="violations">
          <ViolationsTab
            key={panelKey}
            serverUserId={effectiveId}
            identityUserId={identity.userId}
            isSpecificServerScope={isSpecificServerScope}
            scope={identityScope}
            showServer={showServer}
          />
        </TabsContent>
        <TabsContent value="downloads">
          <DownloadsTab
            key={panelKey}
            userId={effectiveId}
            scope={identityScope}
            showServer={showServer}
          />
        </TabsContent>
        <TabsContent value="access">
          <AccessTab
            detail={fullData}
            isOwner={isOwner}
            onAdjustTrust={(account) =>
              setTrustEditTarget({
                id: account.id,
                username: account.username,
                score: account.trustScore,
              })
            }
            onSplit={(account) => setSplitTarget({ id: account.id, username: account.username })}
            splitPending={splitMutation.isPending}
          />
        </TabsContent>
      </Tabs>

      <EditUserIdentityDialog
        open={isEditIdentityOpen}
        onOpenChange={setIsEditIdentityOpen}
        userId={id ?? ''}
        currentName={user.identityName}
        currentContactEmail={identity.contactEmail}
        username={user.username}
      />

      {/* The target names one account, from the header or a linked-accounts row, never the person. */}
      <EditTrustScoreDialog
        open={trustEditTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTrustEditTarget(null);
        }}
        userId={trustEditTarget?.id ?? ''}
        currentScore={trustEditTarget?.score ?? 0}
        username={trustEditTarget?.username ?? ''}
      />

      <SessionDetailSheet
        session={selectedSession}
        open={!!selectedSession}
        onOpenChange={(open) => {
          if (!open) setSelectedSession(null);
        }}
      />

      <ConfirmDialog
        open={splitTarget !== null}
        onOpenChange={(open) => !open && setSplitTarget(null)}
        title={t('pages:userDetail.splitConfirmTitle')}
        description={t('pages:userDetail.splitConfirmDescription')}
        confirmLabel={t('pages:userDetail.splitAccount')}
        confirmLoadingLabel={t('pages:userDetail.splitConfirmLoading')}
        isLoading={splitMutation.isPending}
        onConfirm={() => {
          if (!splitTarget) return;
          splitMutation.mutate(
            { serverUserId: splitTarget.id },
            { onSuccess: () => setSplitTarget(null) }
          );
        }}
      />
    </div>
  );
}
