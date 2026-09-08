import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { format, formatDistanceToNow, parseISO } from 'date-fns';
import { Clock, Crown, Merge, RotateCcw, User as UserIcon } from 'lucide-react';
import type { MergeSuggestion, ServerUserWithIdentity, UserSortField } from '@tracearr/shared';
import {
  MERGE_SAME_SERVER_CONFIRMATION_REQUIRED,
  USER_SORT_FIELDS,
  listPageCount,
} from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { BulkActionsToolbar, type BulkAction } from '@/components/ui/bulk-actions-toolbar';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  createDataTableColumnHelper,
  DataTableBody,
  DataTableEmpty,
  DataTableHeader,
  DataTablePager,
  DataTableRoot,
  DataTableViewport,
  useDataTable,
  type SortingState,
} from '@/components/ui/data-table';
import {
  FilterBar,
  useFilterState,
  type DateRangeValue,
  type FilterDescriptor,
} from '@/components/ui/filters';
import { ErrorState } from '@/components/library/ErrorState';
import { ServerColumnCell } from '@/components/server';
import { MergeSuggestionsBanner } from '@/components/users/MergeSuggestionsBanner';
import { MergeUsersDialog, type MergeCandidate } from '@/components/users/MergeUsersDialog';
import { RemovedBadge } from '@/components/users/RemovedBadge';
import { TrustScoreBadge } from '@/components/users/TrustScoreBadge';
import { UserCell } from '@/components/users/UserCell';
import { getIdentityServers } from '@/components/users/identityServerPills';
import {
  deriveMergeActionState,
  findOverlappingServerName,
} from '@/components/users/mergeSelection';
import { useBulkResetTrust, useMergeUsers, useUsers } from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { useRowSelection } from '@/hooks/useRowSelection';
import { useServer } from '@/hooks/useServer';
import {
  buildUsersRosterParams,
  USERS_FILTER_DEFAULTS,
  type UsersFilterState,
} from './usersFilters';

const PAGE_SIZE = 100;

const SORT_FIELDS = new Set<string>(USER_SORT_FIELDS);

/** Column ids are the API's sort fields, so a header click needs no mapping. */
function isUserSortField(id: string): id is UserSortField {
  return SORT_FIELDS.has(id);
}

const getRowId = (row: ServerUserWithIdentity) => row.id;

const columnHelper = createDataTableColumnHelper<ServerUserWithIdentity>();

const formatFilterDate = (isoDate: string) => format(parseISO(isoDate), 'MMM d, yyyy');

function RelativeTimeCell({
  value,
  fallback,
}: {
  value: Date | string | null | undefined;
  fallback: string;
}) {
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-sm">
      <Clock className="h-4 w-4" />
      {value ? formatDistanceToNow(new Date(value), { addSuffix: true }) : fallback}
    </div>
  );
}

export function Users() {
  const { t } = useTranslation(['pages', 'common']);
  const navigate = useNavigate();
  const { servers, selectedServerIds } = useServer();
  const { user: authUser } = useAuth();

  const isOwner = authUser?.role === 'owner';
  const canResetTrust = isOwner || authUser?.role === 'admin';

  const [page, setPage] = useState(1);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'username', desc: false }]);
  const [resetTrustConfirmOpen, setResetTrustConfirmOpen] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeCandidates, setMergeCandidates] = useState<[MergeCandidate, MergeCandidate] | null>(
    null
  );
  const [mergeRequiredTarget, setMergeRequiredTarget] = useState<string | null>(null);
  const [mergeSameServerWarning, setMergeSameServerWarning] = useState(false);
  const [mergeSameServerName, setMergeSameServerName] = useState<string | null>(null);

  const serverOptions = useMemo(
    () => servers.map((server) => ({ value: server.id, label: server.name })),
    [servers]
  );

  const descriptors = useMemo<FilterDescriptor[]>(() => {
    const formatDateRange = (value: DateRangeValue) => {
      const from = value.from ? formatFilterDate(value.from) : undefined;
      const to = value.to ? formatFilterDate(value.to) : undefined;
      if (from && to) return t('common:filters.dateBetween', { from, to });
      if (from) return t('common:filters.dateAfter', { date: from });
      if (to) return t('common:filters.dateBefore', { date: to });
      return '';
    };
    const dateRangeLabels = {
      placeholder: t('common:filters.anyDate'),
      apply: t('common:actions.apply'),
      cancel: t('common:actions.cancel'),
      clear: t('common:filters.clearDates'),
      clearStart: t('common:filters.clearStartDate'),
      clearEnd: t('common:filters.clearEndDate'),
    };

    return [
      {
        kind: 'search',
        key: 'search',
        label: t('common:actions.search'),
        placeholder: t('pages:users.searchPlaceholder'),
        clearLabel: t('common:filters.clearSearch'),
        inline: true,
        className: 'w-full sm:w-64',
      },
      {
        kind: 'multiSelect',
        key: 'hasAccessTo',
        label: t('pages:users.filterHasAccessTo'),
        options: serverOptions,
        placeholder: t('pages:users.filterHasAccessToPlaceholder'),
        searchPlaceholder: t('common:serverSelector.search'),
        emptyMessage: t('common:serverSelector.noMatches'),
        clearLabel: t('common:actions.clear'),
        countLabel: (count: number) => t('common:count.server', { count }),
        description: t('pages:users.filterHasAccessToHint'),
      },
      {
        kind: 'dateRange',
        key: 'joined',
        label: t('common:labels.joined'),
        labels: dateRangeLabels,
        formatValue: formatDateRange,
        formatDate: formatFilterDate,
      },
      {
        kind: 'dateRange',
        key: 'active',
        label: t('common:labels.lastActivity'),
        labels: dateRangeLabels,
        formatValue: formatDateRange,
        formatDate: formatFilterDate,
      },
      {
        kind: 'boolean',
        key: 'showRemoved',
        label: t('pages:users.showRemoved'),
      },
    ];
  }, [t, serverOptions]);

  const { filters, setFilters } = useFilterState<UsersFilterState>({
    descriptors,
    defaults: USERS_FILTER_DEFAULTS,
    persistence: 'url',
  });

  const rosterParams = useMemo(
    () => buildUsersRosterParams(filters, selectedServerIds),
    [filters, selectedServerIds]
  );

  const activeSort = sorting[0];
  const orderBy = activeSort && isUserSortField(activeSort.id) ? activeSort.id : undefined;
  const orderDir = orderBy ? (activeSort?.desc ? 'desc' : 'asc') : undefined;

  const { data, isLoading, isError, error, refetch } = useUsers({
    page,
    pageSize: PAGE_SIZE,
    orderBy,
    orderDir,
    ...rosterParams,
  });
  const bulkResetTrust = useBulkResetTrust();
  const mergeUsersMutation = useMergeUsers();

  const rows = data?.data;
  const total = data?.meta.total ?? 0;
  const pageCount = data ? listPageCount(data.meta) : 1;

  const {
    selectedIds,
    selectedRows,
    selectAllMode,
    selectedCount,
    toggleRow,
    togglePage,
    selectAll,
    clearSelection,
  } = useRowSelection({ getRowId, totalCount: total, loadedRows: rows, loadKey: page });

  const serverScope = selectedServerIds.join(',');
  useEffect(() => {
    setPage(1);
    clearSelection();
  }, [serverScope, clearSelection]);

  const handleFiltersChange = useCallback(
    (next: UsersFilterState) => {
      setFilters(next);
      setPage(1);
      clearSelection();
    },
    [setFilters, clearSelection]
  );

  const handleSortingChange = useCallback(
    (next: SortingState) => {
      setSorting(next);
      setPage(1);
      clearSelection();
    },
    [clearSelection]
  );

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor('username', {
          header: t('common:labels.user'),
          cell: ({ row }) => {
            const user = row.original;
            return (
              <UserCell
                serverUserId={user.id}
                username={user.username}
                identityName={user.identityName}
                thumbUrl={user.thumbUrl}
                serverId={user.serverId}
                size="md"
                showUsername
                // The row already opens the person, so the cell does not link too.
                link={false}
                muted={user.removedAt !== null}
                trailing={
                  <>
                    {user.role === 'owner' && (
                      <span title={t('common:labels.serverOwner')}>
                        <Crown className="h-4 w-4 text-yellow-500" />
                      </span>
                    )}
                    {user.removedAt && <RemovedBadge removedAt={user.removedAt} />}
                  </>
                }
              />
            );
          },
        }),
        columnHelper.display({
          id: 'servers',
          header: t('pages:users.serversColumn'),
          meta: {
            headerClassName: 'hidden md:table-cell',
            cellClassName: 'hidden md:table-cell',
          },
          cell: ({ row }) => {
            const user = row.original;
            const memberServers = getIdentityServers(user.identityServers, {
              id: user.serverId,
              name: user.serverName,
            });
            return (
              <div className="flex flex-wrap items-center gap-1">
                {memberServers.map((server) => (
                  <ServerColumnCell key={server.id} server={server} />
                ))}
              </div>
            );
          },
        }),
        columnHelper.accessor('identityTrustScore', {
          id: 'trustScore',
          header: t('common:labels.trustScore'),
          cell: ({ row }) => (
            <TrustScoreBadge
              score={row.original.identityTrustScore ?? row.original.trustScore}
              showLabel
            />
          ),
        }),
        columnHelper.accessor('identityJoinedAt', {
          id: 'joinedAt',
          header: t('common:labels.joined'),
          cell: ({ row }) => (
            <RelativeTimeCell
              value={row.original.identityJoinedAt}
              fallback={t('common:labels.unknown')}
            />
          ),
        }),
        columnHelper.accessor('identityLastActivityAt', {
          id: 'lastActivityAt',
          header: t('common:labels.lastActivity'),
          cell: ({ row }) => (
            <RelativeTimeCell
              value={row.original.identityLastActivityAt}
              fallback={t('common:labels.never')}
            />
          ),
        }),
      ]),
    [t]
  );

  const selection = useMemo(
    () => ({
      selectedIds,
      selectAllMode,
      onToggleRow: toggleRow,
      onTogglePage: togglePage,
      labels: {
        selectAllOnPage: t('common:table.selectAllOnPage'),
        selectRow: t('common:table.selectRow'),
      },
    }),
    [selectedIds, selectAllMode, toggleRow, togglePage, t]
  );

  const { table, pager } = useDataTable<ServerUserWithIdentity>({
    columns,
    data: rows,
    getRowId,
    pageSize: PAGE_SIZE,
    pageCount,
    page,
    onPageChange: setPage,
    sorting,
    onSortingChange: handleSortingChange,
    selection,
  });

  const handleBulkResetTrust = () => {
    const params = selectAllMode
      ? { selectAll: true, filters: rosterParams }
      : { ids: Array.from(selectedIds) };

    bulkResetTrust.mutate(params, {
      onSuccess: () => {
        clearSelection();
        setResetTrustConfirmOpen(false);
      },
    });
  };

  const toMergeCandidate = (row: ServerUserWithIdentity): MergeCandidate => ({
    userId: row.userId,
    displayName: `${row.identityName ?? row.username} (${row.serverName})`,
    username: row.username,
    // Server-computed: role alone misses a linked Plex or auth account, and the
    // dialog would then offer a direction the server rejects.
    loginCapable: row.loginCapable ?? false,
    serverUsers: getIdentityServers(row.identityServers, {
      id: row.serverId,
      name: row.serverName,
      serverUserId: row.id,
      removedAt: row.removedAt ? row.removedAt.toISOString() : null,
    }).map((server) => ({
      id: server.serverUserId ?? (server.id === row.serverId ? row.id : server.id),
      serverId: server.id,
      serverName: server.name,
      removedAt:
        server.removedAt ??
        (server.id === row.serverId && row.removedAt ? row.removedAt.toISOString() : null),
    })),
  });

  const mergeSelectionState = deriveMergeActionState(selectedRows, selectAllMode);
  const mergeActionTitle = mergeSelectionState.reasonKey
    ? t(mergeSelectionState.reasonKey)
    : undefined;

  const handleMergeConfirm = (input: {
    sourceUserId: string;
    targetUserId: string;
    confirmSameServerCombine: boolean;
  }) => {
    mergeUsersMutation.mutate(input, {
      onSuccess: () => {
        clearSelection();
        setMergeDialogOpen(false);
      },
      onError: (error) => {
        // Sentinel from a same-server combine the client didn't predict - escalate
        // to the destructive confirmation instead of a toast.
        if (error.message === MERGE_SAME_SERVER_CONFIRMATION_REQUIRED) {
          setMergeSameServerWarning(true);
        }
      },
    });
  };

  const handleReviewSuggestion = (suggestion: MergeSuggestion) => {
    const [firstUser, secondUser] = suggestion.users;
    const toCandidate = (identity: MergeSuggestion['users'][number]): MergeCandidate => ({
      userId: identity.userId,
      displayName: identity.name ?? identity.username,
      username: identity.username,
      loginCapable: identity.loginCapable,
      serverUsers: identity.serverUsers.map((su) => ({
        id: su.id,
        serverId: su.serverId,
        serverName: su.serverName,
        removedAt: su.removedAt,
      })),
    });
    const overlappingServerName = suggestion.wouldCombineSameServer
      ? findOverlappingServerName(firstUser.serverUsers, secondUser.serverUsers)
      : null;

    setMergeCandidates([toCandidate(firstUser), toCandidate(secondUser)]);
    setMergeRequiredTarget(suggestion.requiredTargetUserId);
    setMergeSameServerWarning(suggestion.wouldCombineSameServer);
    setMergeSameServerName(overlappingServerName);
    setMergeDialogOpen(true);
  };

  const bulkActions: BulkAction[] = [
    ...(canResetTrust
      ? [
          {
            key: 'reset-trust',
            label: t('pages:users.resetTrustScore'),
            icon: <RotateCcw className="h-4 w-4" />,
            variant: 'default' as const,
            onClick: () => setResetTrustConfirmOpen(true),
            isLoading: bulkResetTrust.isPending,
          },
        ]
      : []),
    ...(isOwner
      ? [
          {
            key: 'merge',
            label: t('pages:users.mergeUsers'),
            icon: <Merge className="h-4 w-4" />,
            variant: 'default' as const,
            disabled: mergeSelectionState.disabled,
            title: mergeActionTitle,
            onClick: () => {
              const [first, second] = selectedRows;
              if (!first || !second || selectedRows.length !== 2) {
                toast.error(t('pages:users.mergeSelectTwo'));
                return;
              }
              if (first.userId === second.userId) {
                toast.error(t('pages:users.mergeSameIdentity'));
                return;
              }
              const a = toMergeCandidate(first);
              const b = toMergeCandidate(second);
              const sameServer = first.serverId === second.serverId;
              setMergeCandidates([a, b]);
              setMergeRequiredTarget(a.loginCapable ? a.userId : b.loginCapable ? b.userId : null);
              setMergeSameServerWarning(sameServer);
              setMergeSameServerName(sameServer ? first.serverName : null);
              setMergeDialogOpen(true);
            },
            isLoading: mergeUsersMutation.isPending,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">{t('pages:users.title')}</h1>
        <p className="text-muted-foreground text-sm">{t('common:count.user', { count: total })}</p>
      </div>

      {isOwner && <MergeSuggestionsBanner onReview={handleReviewSuggestion} />}

      <Card>
        <CardContent className="space-y-4">
          <FilterBar
            descriptors={descriptors}
            value={filters}
            onChange={handleFiltersChange}
            defaults={USERS_FILTER_DEFAULTS}
            labels={{
              trigger: t('common:labels.filters'),
              panelTitle: t('common:labels.filters'),
              clearAll: t('common:filters.clearAll'),
              done: t('common:filters.done'),
              removeFilter: (label: string) => t('common:filters.remove', { label }),
            }}
          />

          {isError ? (
            <ErrorState
              title={t('common:errors.somethingWentWrong')}
              message={error?.message ?? t('common:errors.unexpectedError')}
              onRetry={() => void refetch()}
            />
          ) : (
            <>
              {selectedCount > 0 && !selectAllMode && total > selectedCount && (
                <div className="flex justify-end">
                  <Button variant="link" size="sm" onClick={selectAll} className="text-sm">
                    {t('pages:users.selectAllUsers', { count: total })}
                  </Button>
                </div>
              )}

              <DataTableRoot density="default">
                <DataTableViewport flush>
                  <DataTableHeader table={table} />
                  <DataTableBody
                    table={table}
                    isLoading={isLoading}
                    loadingLabel={t('common:states.loading')}
                    onRowClick={(user) => {
                      void navigate(`/users/${user.id}`);
                    }}
                    empty={
                      <DataTableEmpty
                        table={table}
                        icon={UserIcon}
                        title={t('pages:users.noUsersFound')}
                      />
                    }
                  />
                </DataTableViewport>
                <DataTablePager
                  {...pager}
                  labels={{
                    navigation: t('common:table.pagination'),
                    status: t('common:table.pageOf', { page: pager.page, total: pager.pageCount }),
                    previous: t('common:actions.previous'),
                    next: t('common:actions.next'),
                  }}
                />
              </DataTableRoot>
            </>
          )}
        </CardContent>
      </Card>

      <BulkActionsToolbar
        selectedCount={selectedCount}
        selectAllMode={selectAllMode}
        totalCount={total}
        actions={bulkActions}
        onClearSelection={clearSelection}
      />

      <ConfirmDialog
        open={resetTrustConfirmOpen}
        onOpenChange={setResetTrustConfirmOpen}
        title={t('pages:users.resetTrustScoreTitle', { count: selectedCount })}
        description={t('pages:users.resetTrustScoreConfirm', { count: selectedCount })}
        confirmLabel={t('pages:users.resetTrustScore')}
        onConfirm={handleBulkResetTrust}
        isLoading={bulkResetTrust.isPending}
      />

      {mergeCandidates &&
        (mergeSameServerWarning ? (
          <MergeUsersDialog
            open={mergeDialogOpen}
            onOpenChange={setMergeDialogOpen}
            candidates={mergeCandidates}
            requiredTargetUserId={mergeRequiredTarget}
            isLoading={mergeUsersMutation.isPending}
            sameServerWarning
            sameServerName={mergeSameServerName ?? ''}
            onConfirm={handleMergeConfirm}
          />
        ) : (
          <MergeUsersDialog
            open={mergeDialogOpen}
            onOpenChange={setMergeDialogOpen}
            candidates={mergeCandidates}
            requiredTargetUserId={mergeRequiredTarget}
            isLoading={mergeUsersMutation.isPending}
            sameServerWarning={false}
            onConfirm={handleMergeConfirm}
          />
        ))}
    </div>
  );
}
