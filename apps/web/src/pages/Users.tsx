import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { formatDistanceToNowStrict } from 'date-fns';
import { Merge, RotateCcw, User as UserIcon } from 'lucide-react';
import type { ServerUserWithIdentity, UserSortField } from '@tracearr/shared';
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
import { MergeSuggestionsCallout } from '@/components/users/MergeSuggestionsCallout';
import { EditTrustScoreDialog } from '@/components/users/EditTrustScoreDialog';
import { EditUserIdentityDialog } from '@/components/users/EditUserIdentityDialog';
import { MergeUsersDialog } from '@/components/users/MergeUsersDialog';
import { ROLE_LABEL_KEYS } from '@/components/users/roleLabels';
import { SignInCell } from '@/components/users/SignInCell';
import { UserCell } from '@/components/users/UserCell';
import { UserFlagsCell } from '@/components/users/UserFlagsCell';
import { UserRowMenu } from '@/components/users/UserRowMenu';
import { getIdentityServers } from '@/components/users/identityServerPills';
import {
  deriveMergeActionState,
  mergeRequestFromRows,
  mergeRequestFromSuggestion,
  withSameServerCombine,
  type MergeRequest,
} from '@/components/users/mergeSelection';
import { useBulkResetTrust, useMergeUsers, useUserFull, useUsers } from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { useRowSelection } from '@/hooks/useRowSelection';
import { useServer } from '@/hooks/useServer';
import { liveFirst } from '@/lib/servers';
import { formatFilterDateRange, formatIsoDay } from '@/lib/dateFormat';
import {
  buildUsersRosterParams,
  ROSTER_ROLES,
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

function RelativeTimeCell({
  value,
  fallback,
}: {
  value: Date | string | null | undefined;
  fallback: string;
}) {
  return (
    <span className="text-muted-foreground text-sm whitespace-nowrap">
      {value ? formatDistanceToNowStrict(new Date(value), { addSuffix: true }) : fallback}
    </span>
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
  const [mergeRequest, setMergeRequest] = useState<MergeRequest | null>(null);
  const [identityTarget, setIdentityTarget] = useState<ServerUserWithIdentity | null>(null);
  const [trustTarget, setTrustTarget] = useState<ServerUserWithIdentity | null>(null);
  // The roster row carries no contact email, so the dialog reads it from the person's detail.
  const identityDetail = useUserFull(identityTarget?.id ?? '');

  const serverOptions = useMemo(
    () =>
      liveFirst(servers).map((server) => ({
        value: server.id,
        label: server.name,
        group: server.historicalAt ? t('common:serverSelector.historical') : undefined,
      })),
    [servers, t]
  );

  const descriptors = useMemo<FilterDescriptor[]>(() => {
    const formatDateRange = (value: DateRangeValue) => formatFilterDateRange(value, t);
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
        placeholder: t('common:search.searchUsers'),
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
        formatDate: formatIsoDay,
      },
      {
        kind: 'dateRange',
        key: 'active',
        label: t('common:labels.lastActivity'),
        labels: dateRangeLabels,
        formatValue: formatDateRange,
        formatDate: formatIsoDay,
      },
      {
        kind: 'boolean',
        key: 'showRemoved',
        label: t('pages:users.showRemoved'),
      },
      {
        kind: 'select',
        key: 'role',
        label: t('pages:userDetail.access.role'),
        allLabel: t('pages:users.filterRoleAll'),
        options: ROSTER_ROLES.map((role) => ({ value: role, label: t(ROLE_LABEL_KEYS[role]) })),
      },
      {
        kind: 'select',
        key: 'signIn',
        label: t('pages:userDetail.access.signIn'),
        allLabel: t('pages:users.filterSignInAll'),
        options: [
          { value: 'allow', label: t('pages:userDetail.access.signInAllow') },
          { value: 'default', label: t('pages:userDetail.access.signInDefault') },
          { value: 'block', label: t('pages:userDetail.access.signInBlock') },
        ],
      },
      {
        kind: 'boolean',
        key: 'pendingOnly',
        label: t('pages:users.filterPendingOnly'),
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

  const multiServer = servers.length > 1;

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor('username', {
          header: t('common:labels.user'),
          cell: ({ row }) => {
            const user = row.original;
            const serverCount = getIdentityServers(user.identityServers, {
              id: user.serverId,
              name: user.serverName,
            }).length;
            return (
              <div className="max-w-56">
                <UserCell
                  serverUserId={user.id}
                  username={user.username}
                  identityName={user.identityName}
                  personName={user.personName}
                  thumbUrl={user.thumbUrl}
                  serverId={user.thumbServerId}
                  size="md"
                  details={[
                    ...(user.email ? [user.email] : []),
                    ...(multiServer ? [t('common:count.server', { count: serverCount })] : []),
                  ]}
                  // The row already opens the person, so the cell does not link too.
                  link={false}
                  muted={user.removedAt !== null}
                />
              </div>
            );
          },
        }),
        columnHelper.accessor('role', {
          header: t('pages:userDetail.access.role'),
          cell: ({ row }) => (
            <span className="text-sm">{t(ROLE_LABEL_KEYS[row.original.role])}</span>
          ),
        }),
        columnHelper.display({
          id: 'signIn',
          header: t('pages:userDetail.access.signIn'),
          cell: ({ row }) => <SignInCell row={row.original} isOwner={isOwner} />,
        }),
        columnHelper.accessor('identityTrustScore', {
          id: 'trustScore',
          header: t('common:labels.status'),
          // Lowest trust first, so the people worth a look come to the top.
          sortDescFirst: false,
          cell: ({ row }) => <UserFlagsCell row={row.original} />,
        }),
        columnHelper.accessor('identityJoinedAt', {
          id: 'joinedAt',
          header: t('common:labels.joined'),
          // The first column to give way, so the table fits a 1280px screen without scrolling.
          meta: {
            headerClassName: 'hidden min-[1400px]:table-cell',
            cellClassName: 'hidden min-[1400px]:table-cell',
          },
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
        columnHelper.display({
          id: 'actions',
          meta: { align: 'end', width: '3rem' },
          cell: ({ row }) => (
            <UserRowMenu
              row={row.original}
              isOwner={isOwner}
              onEditIdentity={setIdentityTarget}
              onAdjustTrust={setTrustTarget}
            />
          ),
        }),
      ]),
    [t, multiServer, isOwner]
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
          setMergeRequest((current) => current && withSameServerCombine(current));
        }
      },
    });
  };

  const openMergeDialog = (request: MergeRequest) => {
    setMergeRequest(request);
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
              openMergeDialog(mergeRequestFromRows(first, second));
            },
            isLoading: mergeUsersMutation.isPending,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <h1 className="sr-only">{t('pages:users.title')}</h1>

      {isOwner && (
        <MergeSuggestionsCallout
          onReview={(suggestion) => openMergeDialog(mergeRequestFromSuggestion(suggestion))}
        />
      )}

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
          >
            <p className="text-muted-foreground ml-auto text-sm">
              {t('common:count.user', { count: total })}
            </p>
          </FilterBar>

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
                  variant="footer"
                  {...pager}
                  labels={{
                    navigation: t('common:table.pagination'),
                    status: t('common:table.pageOf', { page: pager.page, total: pager.pageCount }),
                    previous: t('common:actions.previous'),
                    next: t('common:actions.next'),
                    goToPage: t('common:table.goToPage'),
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

      <EditUserIdentityDialog
        // The contact email comes from the person's detail; opening before it lands would
        // re-seed the form under whatever was already typed.
        open={
          identityTarget !== null && (identityDetail.data !== undefined || identityDetail.isError)
        }
        onOpenChange={(open) => {
          if (!open) setIdentityTarget(null);
        }}
        userId={identityTarget?.id ?? ''}
        currentName={identityTarget?.identityName ?? null}
        currentContactEmail={identityDetail.data?.identity.contactEmail ?? null}
        username={identityDetail.data?.identity.username ?? ''}
      />

      <EditTrustScoreDialog
        open={trustTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTrustTarget(null);
        }}
        userId={trustTarget?.id ?? ''}
        currentScore={trustTarget?.trustScore ?? 0}
        username={trustTarget?.username ?? ''}
      />

      {mergeRequest && (
        <MergeUsersDialog
          {...mergeRequest}
          open={mergeDialogOpen}
          onOpenChange={setMergeDialogOpen}
          isLoading={mergeUsersMutation.isPending}
          onConfirm={handleMergeConfirm}
        />
      )}
    </div>
  );
}
