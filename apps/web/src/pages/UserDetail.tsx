import { useState, useMemo, useCallback, useEffect } from 'react';
import { useParams, useSearchParams, Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  createDataTableColumnHelper,
  DataTableBody,
  DataTableEmpty,
  DataTableHeader,
  DataTablePager,
  DataTableRoot,
  DataTableViewport,
  useDataTable,
} from '@/components/ui/data-table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TrustScoreBadge } from '@/components/users/TrustScoreBadge';
import { UserLocationsCard } from '@/components/users/UserLocationsCard';
import { UserDevicesCard } from '@/components/users/UserDevicesCard';
import { EditUserNameDialog } from '@/components/users/EditUserNameDialog';
import { EditTrustScoreDialog } from '@/components/users/EditTrustScoreDialog';
import { SessionDetailSheet } from '@/components/history/SessionDetailSheet';
import { HistoryTable } from '@/components/history/HistoryTable';
import type { ColumnVisibility } from '@/components/history/HistoryFilters';
import { SeverityBadge } from '@/components/violations/SeverityBadge';
import { getAvatarUrl } from '@/components/users/utils';
import { getMergedIdentityServers } from '@/components/users/identityServerPills';
import { getUserDetailScope, applyUserDetailScope } from '@/components/users/userDetailScope';
import { getPersonRemovedState } from '@/components/users/removedStatus';
import { RemovedBadge } from '@/components/users/RemovedBadge';
import { ServerColumnCell } from '@/components/server';
import { getMediaDisplay, cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { formatWatchTime } from '@/components/ui/stat-card';
import {
  User as UserIcon,
  Crown,
  ArrowLeft,
  Play,
  Clock,
  AlertTriangle,
  XCircle,
  Bot,
  Pencil,
  Split,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import type {
  SessionWithDetails,
  ViolationSummary,
  ViolationWithDetails,
  TerminationLogWithDetails,
} from '@tracearr/shared';
import {
  useUserFull,
  useUserSessions,
  useViolations,
  useUserTerminations,
  useSplitServerUser,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useAuth } from '@/hooks/useAuth';

// Union type for violations - aggregate returns ViolationSummary, paginated returns ViolationWithDetails
type ViolationRow = ViolationSummary | ViolationWithDetails;

// ViolationSummary carries flat serverId/serverName; ViolationWithDetails
// nests it under `server`. Normalize so a single column can render either.
function getViolationServer(violation: ViolationRow): { id: string; name: string } | null {
  if ('serverId' in violation) {
    return { id: violation.serverId, name: violation.serverName };
  }
  return violation.server ? { id: violation.server.id, name: violation.server.name } : null;
}

const violationColumn = createDataTableColumnHelper<ViolationRow>();
const terminationColumn = createDataTableColumnHelper<TerminationLogWithDetails>();
const getRowId = (row: { id: string }) => row.id;

export function UserDetail() {
  const { t } = useTranslation(['pages', 'common']);
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessionsPage, setSessionsPage] = useState(1);
  const [violationsPage, setViolationsPage] = useState(1);
  const [terminationsPage, setTerminationsPage] = useState(1);
  const [isEditNameOpen, setIsEditNameOpen] = useState(false);
  const [trustEditTarget, setTrustEditTarget] = useState<{
    id: string;
    username: string;
    score: number;
  } | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionWithDetails | null>(null);
  const [splitTarget, setSplitTarget] = useState<{ id: string; username: string } | null>(null);
  const pageSize = 10;
  const { servers } = useServer();
  const { user: authUser } = useAuth();
  const isOwner = authUser?.role === 'owner';
  const splitMutation = useSplitServerUser();

  // scope=<serverUserId> narrows the whole page to that one account, like a
  // normal (unmerged) detail view. Absent or scope=all shows the whole
  // person's combined data across every account the caller can access.
  const scopeParam = searchParams.get('scope');
  const { effectiveId, identityScope, isSpecificServerScope, isAllScope } = getUserDetailScope(
    id,
    scopeParam
  );

  const handleScopeChange = useCallback(
    (value: string) => {
      setSearchParams(applyUserDetailScope(searchParams, value), { replace: true });
    },
    [searchParams, setSearchParams]
  );

  // Reset paginated panels to page 1 whenever the scope changes so a stale
  // page number from a larger result set doesn't land past the new total.
  useEffect(() => {
    setSessionsPage(1);
    setViolationsPage(1);
    setTerminationsPage(1);
  }, [scopeParam]);

  const handleSessionClick = useCallback(async (session: SessionWithDetails) => {
    try {
      const full = await api.sessions.get(session.id);
      setSelectedSession(full);
    } catch {
      setSelectedSession(session);
    }
  }, []);

  // Use the aggregate endpoint for initial load (1 request instead of 6).
  // Anchored on effectiveId: the URL's representative account by default, or
  // the specific sibling account the picker selected.
  const { data: fullData, isLoading } = useUserFull(effectiveId!, { scope: identityScope });

  // Only fetch paginated data when user navigates beyond first page
  const { data: paginatedSessions, isLoading: paginatedSessionsLoading } = useUserSessions(
    effectiveId!,
    { page: sessionsPage, pageSize, scope: identityScope }
    // Only enable when on page > 1 (first page data comes from aggregate)
  );
  const needsPaginatedSessions = sessionsPage > 1;

  const identityUserId = fullData?.identity.userId;
  const { data: paginatedViolations, isLoading: paginatedViolationsLoading } = useViolations(
    isSpecificServerScope
      ? { serverUserId: effectiveId, page: violationsPage, pageSize }
      : {
          userId: identityUserId,
          page: violationsPage,
          pageSize,
          enabled: !!identityUserId,
        }
  );
  const needsPaginatedViolations = violationsPage > 1;

  const { data: paginatedTerminations, isLoading: paginatedTerminationsLoading } =
    useUserTerminations(effectiveId!, { page: terminationsPage, pageSize, scope: identityScope });
  const needsPaginatedTerminations = terminationsPage > 1;

  // Extract data from aggregate or paginated sources
  const user = fullData?.user;
  const identity = fullData?.identity;
  const locations = fullData?.locations ?? [];
  const devices = fullData?.devices ?? [];
  const isMergedIdentity = (identity?.serverUsers.length ?? 0) > 1;
  // The server column/badges only earn their place once the view actually
  // spans more than one server - never for an unmerged person.
  const showServerColumns = isAllScope && isMergedIdentity;
  const headerMergedServers = getMergedIdentityServers(
    identity?.serverUsers.map((account) => ({ id: account.serverId, name: account.serverName }))
  );

  // Column visibility for the sessions HistoryTable.
  const sessionColumnVisibility: ColumnVisibility = useMemo(
    () => ({
      date: true,
      user: false,
      content: true,
      server: showServerColumns,
      platform: true,
      location: true,
      ip: false,
      quality: true,
      duration: true,
      progress: true,
    }),
    [showServerColumns]
  );

  const violationColumns = useMemo(
    () =>
      violationColumn.columns([
        violationColumn.accessor((violation) => violation.rule.name, {
          id: 'rule.name',
          header: t('common:labels.rule'),
          cell: ({ row }) => (
            <div>
              <p className="font-medium">{row.original.rule.name}</p>
              <p className="text-muted-foreground text-xs capitalize">
                {row.original.rule.type?.replace(/_/g, ' ') ?? t('automations.customAutomation')}
              </p>
            </div>
          ),
        }),
        ...(showServerColumns
          ? [
              violationColumn.display({
                id: 'server',
                header: t('common:labels.server'),
                cell: ({ row }) => {
                  const server = getViolationServer(row.original);
                  return server ? <ServerColumnCell server={server} /> : null;
                },
              }),
            ]
          : []),
        violationColumn.accessor('severity', {
          header: t('common:labels.severity'),
          cell: ({ row }) => (
            <SeverityBadge severity={row.original.severity as 'low' | 'warning' | 'high'} />
          ),
        }),
        violationColumn.accessor('createdAt', {
          header: t('common:labels.when'),
          cell: ({ row }) => (
            <span className="text-muted-foreground text-sm">
              {formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
            </span>
          ),
        }),
        violationColumn.accessor('acknowledgedAt', {
          header: t('common:labels.status'),
          cell: ({ row }) => (
            <span
              className={
                row.original.acknowledgedAt
                  ? 'text-muted-foreground'
                  : 'font-medium text-yellow-500'
              }
            >
              {row.original.acknowledgedAt
                ? t('common:states.acknowledged')
                : t('common:states.pending')}
            </span>
          ),
        }),
      ]),
    [t, showServerColumns]
  );

  const terminationColumns = useMemo(
    () =>
      terminationColumn.columns([
        terminationColumn.accessor('trigger', {
          header: t('common:labels.type'),
          cell: ({ row }) => (
            <Badge variant={row.original.trigger === 'manual' ? 'default' : 'secondary'}>
              {row.original.trigger === 'manual' ? (
                <>
                  <UserIcon className="mr-1 h-3 w-3" />
                  {t('pages:userDetail.manual')}
                </>
              ) : (
                <>
                  <Bot className="mr-1 h-3 w-3" />
                  {t('common:labels.rule')}
                </>
              )}
            </Badge>
          ),
        }),
        terminationColumn.accessor('mediaTitle', {
          header: t('common:labels.media'),
          cell: ({ row }) => {
            const { title, subtitle } = getMediaDisplay(row.original);
            return (
              <div className="max-w-[200px]">
                <p className="truncate font-medium">{title || '—'}</p>
                {subtitle ? (
                  <p className="text-muted-foreground text-xs">{subtitle}</p>
                ) : (
                  <p className="text-muted-foreground text-xs capitalize">
                    {row.original.mediaType ?? t('common:labels.unknown').toLowerCase()}
                  </p>
                )}
              </div>
            );
          },
        }),
        ...(showServerColumns
          ? [
              terminationColumn.display({
                id: 'server',
                header: t('common:labels.server'),
                cell: ({ row }) =>
                  row.original.serverName ? (
                    <ServerColumnCell
                      server={{ id: row.original.serverId, name: row.original.serverName }}
                    />
                  ) : null,
              }),
            ]
          : []),
        terminationColumn.accessor('createdAt', {
          header: t('common:labels.when'),
          cell: ({ row }) => (
            <span className="text-muted-foreground text-sm">
              {formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
            </span>
          ),
        }),
        terminationColumn.accessor('triggeredByUsername', {
          header: t('pages:userDetail.byRule'),
          cell: ({ row }) => {
            const log = row.original;
            if (log.trigger === 'manual') {
              return (
                <span className="text-sm">
                  @{log.triggeredByUsername ?? t('common:labels.unknown')}
                </span>
              );
            }
            return (
              <span className="text-muted-foreground text-sm">
                {log.ruleName ?? t('pages:userDetail.unknownRule')}
              </span>
            );
          },
        }),
        terminationColumn.accessor('reason', {
          header: t('common:labels.reason'),
          cell: ({ row }) => (
            <span className="text-muted-foreground block max-w-[150px] truncate text-sm">
              {row.original.reason ?? '—'}
            </span>
          ),
        }),
        terminationColumn.accessor('success', {
          header: t('common:labels.status'),
          cell: ({ row }) => (
            <span className={row.original.success ? 'text-green-500' : 'font-medium text-red-500'}>
              {row.original.success ? t('common:states.success') : t('common:states.failed')}
            </span>
          ),
        }),
      ]),
    [t, showServerColumns]
  );

  // Sessions: use paginated data if on page > 1, otherwise use aggregate
  const rawSessions = needsPaginatedSessions
    ? (paginatedSessions?.data ?? [])
    : (fullData?.sessions.data ?? []);

  // Map Session -> SessionWithDetails for HistoryTable compatibility. Each
  // session row already carries its own server, since an identity-scoped
  // view can mix sessions from more than one server.
  const sessions: SessionWithDetails[] = useMemo(() => {
    if (!user) return [];
    return rawSessions.map((s) => {
      const server = servers.find((sv) => sv.id === s.serverId);
      return {
        ...s,
        user: {
          id: user.id,
          username: user.username,
          thumbUrl: user.thumbUrl,
          identityName: user.identityName ?? null,
        },
        server: {
          id: s.serverId,
          name: s.serverName ?? server?.name ?? '',
          type: server?.type ?? 'plex',
        },
      };
    });
  }, [rawSessions, user, servers]);

  const sessionsTotal = needsPaginatedSessions
    ? (paginatedSessions?.total ?? fullData?.sessions.total ?? 0)
    : (fullData?.sessions.total ?? 0);
  const sessionsTotalPages = Math.ceil(sessionsTotal / pageSize);
  const sessionsLoading = needsPaginatedSessions ? paginatedSessionsLoading : isLoading;

  // Violations: use paginated data if on page > 1, otherwise use aggregate
  const violations: ViolationRow[] = needsPaginatedViolations
    ? (paginatedViolations?.data ?? [])
    : (fullData?.violations.data ?? []);
  const violationsTotal = needsPaginatedViolations
    ? (paginatedViolations?.meta.total ?? fullData?.violations.total ?? 0)
    : (fullData?.violations.total ?? 0);
  const violationsTotalPages = Math.ceil(violationsTotal / pageSize);
  const violationsLoading = needsPaginatedViolations ? paginatedViolationsLoading : isLoading;

  // Terminations: use paginated data if on page > 1, otherwise use aggregate
  const terminations = needsPaginatedTerminations
    ? (paginatedTerminations?.data ?? [])
    : (fullData?.terminations.data ?? []);
  const terminationsTotal = needsPaginatedTerminations
    ? (paginatedTerminations?.total ?? fullData?.terminations.total ?? 0)
    : (fullData?.terminations.total ?? 0);
  const terminationsTotalPages = Math.ceil(terminationsTotal / pageSize);
  const terminationsLoading = needsPaginatedTerminations ? paginatedTerminationsLoading : isLoading;

  const { table: violationsTable, pager: violationsPager } = useDataTable<ViolationRow>({
    columns: violationColumns,
    data: violations,
    getRowId,
    pageSize,
    pageCount: violationsTotalPages,
    page: violationsPage,
    onPageChange: setViolationsPage,
  });

  const { table: terminationsTable, pager: terminationsPager } =
    useDataTable<TerminationLogWithDetails>({
      columns: terminationColumns,
      data: terminations,
      getRowId,
      pageSize,
      pageCount: terminationsTotalPages,
      page: terminationsPage,
      onPageChange: setTerminationsPage,
    });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardContent>
              <div className="flex items-center gap-4">
                <Skeleton className="h-16 w-16 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-6 w-32" />
                  <Skeleton className="h-4 w-24" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-16" />
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="space-y-6">
        <Link to="/users">
          <Button variant="ghost" size="sm">
            <ArrowLeft />
            {t('userDetail.backToUsers')}
          </Button>
        </Link>
        <Card>
          <CardContent className="flex h-32 items-center justify-center">
            <p className="text-muted-foreground">{t('userDetail.userNotFound')}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const removedBadgeState = isSpecificServerScope
    ? user.removedAt
      ? { removed: true as const, removedAt: user.removedAt }
      : { removed: false as const }
    : getPersonRemovedState(identity?.serverUsers);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <Link to="/users">
          <Button variant="ghost" size="sm">
            <ArrowLeft />
            {t('common:actions.back')}
          </Button>
        </Link>
        <h1 className="text-3xl font-bold">{user.identityName ?? user.username}</h1>
        {isSpecificServerScope ? (
          <ServerColumnCell server={{ id: user.serverId, name: user.serverName }} />
        ) : (
          headerMergedServers.map((server) => <ServerColumnCell key={server.id} server={server} />)
        )}
        {isMergedIdentity && (
          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="user-scope" className="text-muted-foreground text-sm">
              {t('pages:userDetail.serverScope')}
            </label>
            <Select value={scopeParam ?? 'all'} onValueChange={handleScopeChange}>
              <SelectTrigger id="user-scope" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('pages:userDetail.allServers')}</SelectItem>
                {identity?.serverUsers.map((account) => (
                  <SelectItem key={account.id} value={account.id} textValue={account.serverName}>
                    <span className="flex items-center gap-2">
                      {account.serverName}
                      {account.removedAt && <RemovedBadge removedAt={account.removedAt} />}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* User Info Card */}
        <Card>
          <CardHeader>
            <CardTitle>{t('userDetail.userInfo')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-start gap-4">
              <div className="bg-muted flex h-16 w-16 items-center justify-center rounded-full">
                {(() => {
                  const avatarUrl = getAvatarUrl(user.serverId, user.thumbUrl, 64);
                  return avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt={user.username}
                      className="h-16 w-16 rounded-full object-cover"
                    />
                  ) : (
                    <UserIcon className="text-muted-foreground h-8 w-8" />
                  );
                })()}
              </div>
              <div className="flex flex-1 items-start justify-between gap-6">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2
                      className={cn(
                        'text-xl font-semibold',
                        removedBadgeState.removed && 'text-muted-foreground line-through'
                      )}
                    >
                      {user.identityName ?? user.username}
                    </h2>
                    {isOwner && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setIsEditNameOpen(true)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    {user.role === 'owner' && (
                      <span title={t('common:labels.serverOwner')}>
                        <Crown className="h-5 w-5 text-yellow-500" />
                      </span>
                    )}
                    {removedBadgeState.removed && (
                      <RemovedBadge removedAt={removedBadgeState.removedAt} />
                    )}
                  </div>
                  <p className="text-muted-foreground text-sm">@{user.username}</p>
                  {user.email && <p className="text-muted-foreground text-sm">{user.email}</p>}
                  <div className="flex items-center gap-4 pt-2">
                    <TrustScoreBadge
                      score={
                        isAllScope && isMergedIdentity
                          ? (identity?.aggregateTrustScore ?? user.trustScore)
                          : user.trustScore
                      }
                      showLabel
                    />
                    {isAllScope && isMergedIdentity && (
                      <span className="text-muted-foreground text-xs">
                        {t('pages:userDetail.overallTrust')}
                      </span>
                    )}
                  </div>
                  {isOwner && (!isMergedIdentity || !isAllScope) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3 w-fit"
                      onClick={() =>
                        setTrustEditTarget({
                          id: user.id,
                          username: user.username,
                          score: user.trustScore,
                        })
                      }
                    >
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      {t('userDetail.adjustTrustScore')}
                    </Button>
                  )}
                </div>
                <div className="text-muted-foreground flex flex-col gap-2 text-right text-sm">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    <span className="text-foreground font-medium">{t('common:labels.joined')}</span>
                    <span>{format(new Date(user.joinedAt ?? user.createdAt), 'MMM d, yyyy')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    <span className="text-foreground font-medium">
                      {t('common:labels.lastActivity')}
                    </span>
                    <span>
                      {user.lastActivityAt
                        ? format(new Date(user.lastActivityAt), 'MMM d, yyyy')
                        : '—'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stats Card */}
        <Card>
          <CardHeader>
            <CardTitle>{t('pages:userDetail.statistics')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <Play className="text-muted-foreground h-4 w-4" />
                  <span className="text-muted-foreground text-sm">
                    {t('pages:userDetail.sessions')}
                  </span>
                </div>
                <p className="mt-1 text-2xl font-bold">{user.stats.totalSessions}</p>
              </div>
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="text-muted-foreground h-4 w-4" />
                  <span className="text-muted-foreground text-sm">
                    {t('pages:userDetail.violations')}
                  </span>
                </div>
                <p className="mt-1 text-2xl font-bold">{violationsTotal}</p>
              </div>
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-sm">
                    {t('common:labels.trustScore')}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-2xl font-bold">{user.trustScore}</span>
                  <span className="text-muted-foreground text-sm">/ 100</span>
                </div>
              </div>
              {isMergedIdentity && (
                <div className="rounded-lg border p-4">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground text-sm">
                      {t('pages:userDetail.overallTrust')}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-2xl font-bold">
                      {identity?.aggregateTrustScore ?? user.trustScore}
                    </span>
                    <span className="text-muted-foreground text-sm">/ 100</span>
                  </div>
                </div>
              )}
            </div>
            {isSpecificServerScope && isMergedIdentity && identity && (
              <p className="text-muted-foreground mt-3 text-xs">
                {t('pages:userDetail.acrossAllServers')}{' '}
                {t('common:count.session', { count: identity.stats.totalSessions })} ·{' '}
                {formatWatchTime(identity.stats.totalWatchTime)}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Linked Accounts */}
      {identity && isMergedIdentity && (
        <Card>
          <CardHeader>
            <CardTitle>{t('pages:userDetail.linkedAccounts')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {identity.serverUsers.map((account) => (
              <div
                key={account.id}
                className="flex items-center justify-between gap-4 rounded-md border p-3"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p
                      className={cn(
                        'font-medium',
                        account.removedAt && 'text-muted-foreground line-through'
                      )}
                    >
                      {account.username}
                    </p>
                    {account.removedAt && <RemovedBadge removedAt={account.removedAt} />}
                  </div>
                  <ServerColumnCell server={{ id: account.serverId, name: account.serverName }} />
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-muted-foreground text-xs whitespace-nowrap">
                    {t('common:count.session', { count: account.sessionCount })}
                  </span>
                  <TrustScoreBadge score={account.trustScore} />
                  {isOwner && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setTrustEditTarget({
                          id: account.id,
                          username: account.username,
                          score: account.trustScore,
                        })
                      }
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      {t('userDetail.adjustTrustScore')}
                    </Button>
                  )}
                  {isOwner && account.id !== user.id && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSplitTarget({ id: account.id, username: account.username })}
                      disabled={splitMutation.isPending}
                    >
                      <Split />
                      {t('pages:userDetail.splitAccount')}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Locations and Devices */}
      <div className="grid gap-6 lg:grid-cols-2">
        <UserLocationsCard
          locations={locations}
          isLoading={isLoading}
          totalSessions={sessionsTotal}
        />
        <UserDevicesCard devices={devices} isLoading={isLoading} totalSessions={sessionsTotal} />
      </div>

      {/* Recent Sessions */}
      <Card>
        <CardHeader>
          <CardTitle>{t('common:labels.recentSessions')}</CardTitle>
        </CardHeader>
        <CardContent>
          <HistoryTable
            sessions={sessions}
            isLoading={sessionsLoading}
            onSessionClick={handleSessionClick}
            columnVisibility={sessionColumnVisibility}
          />
          {sessionsTotalPages > 1 && (
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSessionsPage((p) => Math.max(1, p - 1))}
                disabled={sessionsPage <= 1}
              >
                {t('common:actions.previous')}
              </Button>
              <span className="text-muted-foreground text-sm">
                {sessionsPage} / {sessionsTotalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSessionsPage((p) => Math.min(sessionsTotalPages, p + 1))}
                disabled={sessionsPage >= sessionsTotalPages}
              >
                {t('common:actions.next')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Violations */}
      <Card>
        <CardHeader>
          <CardTitle>{t('userDetail.violations')}</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTableRoot>
            <DataTableViewport flush>
              <DataTableHeader table={violationsTable} />
              <DataTableBody
                table={violationsTable}
                isLoading={violationsLoading}
                loadingLabel={t('common:states.loading')}
                empty={
                  <DataTableEmpty
                    table={violationsTable}
                    title={t('userDetail.noViolationsFound')}
                  />
                }
              />
            </DataTableViewport>
            <DataTablePager
              {...violationsPager}
              labels={{
                navigation: t('common:table.pagination'),
                status: t('common:table.pageOf', {
                  page: violationsPager.page,
                  total: violationsPager.pageCount,
                }),
                previous: t('common:actions.previous'),
                next: t('common:actions.next'),
              }}
            />
          </DataTableRoot>
        </CardContent>
      </Card>

      {/* Termination History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <XCircle className="h-5 w-5" />
            {t('userDetail.terminationHistory')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTableRoot>
            <DataTableViewport flush>
              <DataTableHeader table={terminationsTable} />
              <DataTableBody
                table={terminationsTable}
                isLoading={terminationsLoading}
                loadingLabel={t('common:states.loading')}
                empty={
                  <DataTableEmpty
                    table={terminationsTable}
                    title={t('userDetail.noTerminationsFound')}
                  />
                }
              />
            </DataTableViewport>
            <DataTablePager
              {...terminationsPager}
              labels={{
                navigation: t('common:table.pagination'),
                status: t('common:table.pageOf', {
                  page: terminationsPager.page,
                  total: terminationsPager.pageCount,
                }),
                previous: t('common:actions.previous'),
                next: t('common:actions.next'),
              }}
            />
          </DataTableRoot>
        </CardContent>
      </Card>

      {/* Edit Display Name Dialog */}
      <EditUserNameDialog
        open={isEditNameOpen}
        onOpenChange={setIsEditNameOpen}
        userId={id!}
        currentName={user.identityName}
        username={user.username}
      />

      {/* Edit Trust Score Dialog - target carries explicit account context,
          set from either the header (single-account view) or a specific
          Linked Accounts row, never ambiguous at the person level */}
      <EditTrustScoreDialog
        open={trustEditTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTrustEditTarget(null);
        }}
        userId={trustEditTarget?.id ?? ''}
        currentScore={trustEditTarget?.score ?? 0}
        username={trustEditTarget?.username ?? ''}
      />

      {/* Session Detail Sheet */}
      <SessionDetailSheet
        session={selectedSession}
        open={!!selectedSession}
        onOpenChange={(open) => {
          if (!open) setSelectedSession(null);
        }}
      />

      {/* Split Account Confirmation */}
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
