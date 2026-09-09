import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { format, formatDistanceToNow, parseISO } from 'date-fns';
import { AlertTriangle, Check, Trash2, UserRoundSearch, X } from 'lucide-react';
import type { ViolationWithDetails } from '@tracearr/shared';
import { VIOLATION_SORT_FIELDS, listPageCount, type ViolationSortField } from '@tracearr/shared';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { BulkActionsToolbar, type BulkAction } from '@/components/ui/bulk-actions-toolbar';
import { Card, CardContent } from '@/components/ui/card';
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
  countActiveFilters,
  FilterBar,
  setFilterValue,
  useFilterState,
  type DateRangeValue,
  type FilterDescriptor,
} from '@/components/ui/filters';
import { ErrorState } from '@/components/library/ErrorState';
import { ServerColumnCell } from '@/components/server';
import { UserCell } from '@/components/users/UserCell';
import { getAvatarUrl } from '@/components/users/utils';
import { PersonMultiSelectCombobox } from '@/components/violations/PersonMultiSelectCombobox';
import { ruleIcons } from '@/components/violations/ruleIcons';
import { SeverityBadge } from '@/components/violations/SeverityBadge';
import {
  useAcknowledgeViolation,
  useAutomations,
  useBulkAcknowledgeViolations,
  useBulkDismissViolations,
  useDismissViolation,
  useUsers,
  useViolations,
} from '@/hooks/queries';
import { useRowSelection } from '@/hooks/useRowSelection';
import { useServer } from '@/hooks/useServer';
import { useServerColorMap } from '@/hooks/useServerColorMap';
import {
  buildViolationFilterParams,
  VIOLATIONS_FILTER_DEFAULTS,
  type ViolationsFilterState,
} from './violationsFilters';

const PAGE_SIZE = 10;

const PERSON_OPTIONS_PAGE_SIZE = 100;

const RULE_OPTIONS_PAGE_SIZE = 100;

/** Rendered inline by the page itself, so FilterBar never gets a descriptor for it. */
const PEOPLE_FILTER_KEY = 'people';
const PEOPLE_FILTER_TRIGGER_ID = 'violations-person-filter';

const SORT_FIELDS = new Set<string>(VIOLATION_SORT_FIELDS);

/** Column ids are the API's sort fields, so a header click needs no mapping. */
function isViolationSortField(id: string): id is ViolationSortField {
  return SORT_FIELDS.has(id);
}

const violationColumn = createDataTableColumnHelper<ViolationWithDetails>();
const getViolationId = (violation: ViolationWithDetails) => violation.id;

const formatFilterDate = (isoDate: string) => format(parseISO(isoDate), 'MMM d, yyyy');

export function Violations() {
  const { t } = useTranslation(['pages', 'common']);
  const navigate = useNavigate();
  const { selectedServerIds, selectedServers, isMultiServer } = useServer();
  const colorMap = useServerColorMap();

  const [page, setPage] = useState(1);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }]);
  const [personSearch, setPersonSearch] = useState('');
  const [dismissId, setDismissId] = useState<string | null>(null);
  const [bulkDismissConfirmOpen, setBulkDismissConfirmOpen] = useState(false);

  // One page covers the dropdown: the filter names an automation, it does not
  // page through them. Only policy automations reach this list, so the other
  // kinds would filter it down to nothing.
  const { data: automations } = useAutomations({
    kind: 'policy',
    pageSize: RULE_OPTIONS_PAGE_SIZE,
  });
  const ruleOptions = useMemo(
    () => automations?.data.map((automation) => ({ value: automation.id, label: automation.name })),
    [automations]
  );

  const descriptors = useMemo<FilterDescriptor[]>(
    () => [
      {
        kind: 'select',
        key: 'severity',
        label: t('common:labels.severity'),
        allLabel: t('pages:violations.allSeverities'),
        options: [
          { value: 'high', label: t('common:severity.high') },
          { value: 'warning', label: t('common:severity.warning') },
          { value: 'low', label: t('common:severity.low') },
        ],
      },
      {
        kind: 'select',
        key: 'status',
        label: t('common:labels.status'),
        allLabel: t('pages:violations.allStatuses'),
        options: [
          { value: 'pending', label: t('common:states.pending') },
          { value: 'acknowledged', label: t('common:states.acknowledged') },
        ],
      },
      {
        kind: 'select',
        key: 'rule',
        label: t('common:labels.rule'),
        allLabel: t('pages:violations.allRules'),
        options: ruleOptions,
      },
      {
        kind: 'dateRange',
        key: 'occurred',
        label: t('common:labels.when'),
        labels: {
          placeholder: t('common:filters.anyDate'),
          apply: t('common:actions.apply'),
          cancel: t('common:actions.cancel'),
          clear: t('common:filters.clearDates'),
          clearStart: t('common:filters.clearStartDate'),
          clearEnd: t('common:filters.clearEndDate'),
        },
        formatValue: (value: DateRangeValue) => {
          const from = value.from ? formatFilterDate(value.from) : undefined;
          const to = value.to ? formatFilterDate(value.to) : undefined;
          if (from && to) return t('common:filters.dateBetween', { from, to });
          if (from) return t('common:filters.dateAfter', { date: from });
          if (to) return t('common:filters.dateBefore', { date: to });
          return '';
        },
        formatDate: formatFilterDate,
      },
      {
        kind: 'multiSelect',
        key: PEOPLE_FILTER_KEY,
        label: t('pages:violations.filterPeople'),
        // The roster outgrows one page, so the picker searches server-side and
        // its loaded page is never the authoritative option list. Leaving these
        // unset stops a linked person id being dropped as unrecognised.
        options: undefined,
        placeholder: t('pages:violations.allPeople'),
        searchPlaceholder: t('pages:violations.personFilterPlaceholder'),
        emptyMessage: t('pages:violations.personFilterEmpty'),
        clearLabel: t('common:actions.clear'),
        countLabel: (count: number) => t('pages:violations.peopleSelectedCount', { count }),
      },
    ],
    [t, ruleOptions]
  );

  const barDescriptors = useMemo(
    () => descriptors.filter((descriptor) => descriptor.key !== PEOPLE_FILTER_KEY),
    [descriptors]
  );

  const { filters, setFilters } = useFilterState<ViolationsFilterState>({
    descriptors,
    defaults: VIOLATIONS_FILTER_DEFAULTS,
    persistence: 'url',
  });

  // The bulk acknowledge and dismiss payloads read this same object, so a
  // filter added here narrows the list and the bulk action together.
  const filterParams = useMemo(
    () => buildViolationFilterParams(filters, selectedServerIds),
    [filters, selectedServerIds]
  );

  const activeSort = sorting[0];
  const orderBy = activeSort && isViolationSortField(activeSort.id) ? activeSort.id : undefined;
  const orderDir = orderBy ? (activeSort?.desc ? 'desc' : 'asc') : undefined;

  const { data, isLoading, isError, error, refetch } = useViolations({
    page,
    pageSize: PAGE_SIZE,
    ...filterParams,
    orderBy,
    orderDir,
  });
  const { mutate: acknowledge, isPending: isAcknowledging } = useAcknowledgeViolation();
  const { mutate: dismiss, isPending: isDismissing } = useDismissViolation();
  const bulkAcknowledge = useBulkAcknowledgeViolations();
  const bulkDismiss = useBulkDismissViolations();

  const rows = data?.data;
  const total = data?.meta.total ?? 0;
  const pageCount = data ? listPageCount(data.meta) : 1;

  // One entry per identity, scoped to the selected servers so the picker never
  // offers someone the caller cannot see.
  const {
    data: personOptionsData,
    isLoading: personOptionsLoading,
    isError: personOptionsError,
  } = useUsers({
    pageSize: PERSON_OPTIONS_PAGE_SIZE,
    serverIds: selectedServerIds.length > 0 ? selectedServerIds : undefined,
    search: personSearch || undefined,
  });
  const personOptions = useMemo(() => personOptionsData?.data ?? [], [personOptionsData]);

  const selectedPeopleIds = useMemo(() => filters.people ?? [], [filters.people]);

  // Display info for every selected person, used by the summary card(s) and as
  // a name fallback for the picker's trigger. Prefer the roster option, which
  // carries identityServers for the server badges, and fall back to a loaded
  // row so someone linked in from a row action still resolves to a name.
  const selectedPeople = useMemo(() => {
    return selectedPeopleIds
      .map((id) => {
        const fromOptions = personOptions.find((option) => option.userId === id);
        if (fromOptions) return fromOptions;
        const fromRow = rows?.find((violation) => violation.user.userId === id);
        if (!fromRow) return undefined;
        return {
          userId: id,
          identityName: fromRow.user.identityName,
          username: fromRow.user.username,
          thumbUrl: fromRow.user.thumbUrl,
          serverId: fromRow.user.serverId,
          identityServers: undefined as { id: string; name: string }[] | undefined,
        };
      })
      .filter((person): person is NonNullable<typeof person> => person !== undefined);
  }, [selectedPeopleIds, personOptions, rows]);

  const resolvePersonName = useCallback(
    (id: string) => {
      const person = selectedPeople.find((candidate) => candidate.userId === id);
      return person ? (person.identityName ?? person.username) : undefined;
    },
    [selectedPeople]
  );

  const {
    selectedIds,
    selectAllMode,
    selectedCount,
    toggleRow,
    togglePage,
    selectAll,
    clearSelection,
  } = useRowSelection({
    getRowId: getViolationId,
    totalCount: total,
    loadedRows: rows,
    loadKey: page,
  });

  const serverScope = selectedServerIds.join(',');
  useEffect(() => {
    setPage(1);
    clearSelection();
  }, [serverScope, clearSelection]);

  const applyFilters = useCallback(
    (next: ViolationsFilterState) => {
      setFilters(next);
      setPage(1);
      clearSelection();
    },
    [setFilters, clearSelection]
  );

  const handlePersonFilterChange = useCallback(
    (userIds: string[]) => {
      applyFilters(
        setFilterValue(filters, PEOPLE_FILTER_KEY, userIds.length > 0 ? userIds : undefined)
      );
    },
    [filters, applyFilters]
  );

  const handleAddPersonToFilter = useCallback(
    (userId: string) => {
      if (selectedPeopleIds.includes(userId)) return;
      applyFilters(setFilterValue(filters, PEOPLE_FILTER_KEY, [...selectedPeopleIds, userId]));
    },
    [filters, selectedPeopleIds, applyFilters]
  );

  const handleSortingChange = useCallback(
    (next: SortingState) => {
      setSorting(next);
      setPage(1);
      clearSelection();
    },
    [clearSelection]
  );

  const handleDismiss = () => {
    if (!dismissId) return;
    dismiss(dismissId, { onSuccess: () => setDismissId(null) });
  };

  const handleBulkAcknowledge = () => {
    const params = selectAllMode
      ? { selectAll: true, filters: filterParams }
      : { ids: Array.from(selectedIds) };

    bulkAcknowledge.mutate(params, { onSuccess: clearSelection });
  };

  const handleBulkDismiss = () => {
    const params = selectAllMode
      ? { selectAll: true, filters: filterParams }
      : { ids: Array.from(selectedIds) };

    bulkDismiss.mutate(params, {
      onSuccess: () => {
        clearSelection();
        setBulkDismissConfirmOpen(false);
      },
    });
  };

  const bulkActions: BulkAction[] = [
    {
      key: 'acknowledge',
      label: t('common:actions.acknowledge'),
      icon: <Check className="h-4 w-4" />,
      variant: 'default',
      onClick: handleBulkAcknowledge,
      isLoading: bulkAcknowledge.isPending,
    },
    {
      key: 'dismiss',
      label: t('common:actions.dismiss'),
      icon: <Trash2 className="h-4 w-4" />,
      variant: 'destructive',
      onClick: () => setBulkDismissConfirmOpen(true),
      isLoading: bulkDismiss.isPending,
    },
  ];

  const columns = useMemo(
    () =>
      violationColumn.columns([
        ...(isMultiServer
          ? [
              violationColumn.display({
                id: 'server',
                header: t('common:labels.server'),
                cell: ({ row }) => {
                  const server =
                    (row.original.server?.id
                      ? selectedServers.find((s) => s.id === row.original.server!.id)
                      : undefined) ?? row.original.server;
                  return server ? <ServerColumnCell server={server} /> : null;
                },
              }),
            ]
          : []),
        violationColumn.accessor('user', {
          header: t('common:labels.user'),
          cell: ({ row }) => {
            const violation = row.original;
            const personId = violation.user.userId;
            return (
              <UserCell
                serverUserId={violation.user.id}
                username={violation.user.username}
                identityName={violation.user.identityName}
                thumbUrl={violation.user.thumbUrl}
                serverId={violation.user.serverId}
                size="md"
                trailing={
                  personId && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-foreground h-6 w-6 shrink-0"
                      title={t('pages:violations.filterByPerson')}
                      aria-label={t('pages:violations.filterByPerson')}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAddPersonToFilter(personId);
                      }}
                    >
                      <UserRoundSearch className="h-3.5 w-3.5" />
                    </Button>
                  )
                }
              />
            );
          },
        }),
        violationColumn.accessor('rule', {
          header: t('common:labels.rule'),
          cell: ({ row }) => {
            const violation = row.original;
            return (
              <div className="flex items-center gap-2">
                <div className="bg-muted flex h-8 w-8 items-center justify-center rounded">
                  {(violation.rule.type && ruleIcons[violation.rule.type]) ?? (
                    <AlertTriangle className="h-4 w-4" />
                  )}
                </div>
                <div>
                  <p className="font-medium">{violation.rule.name}</p>
                  <p className="text-muted-foreground text-xs capitalize">
                    {violation.rule.type?.replace(/_/g, ' ') ?? 'Custom Rule'}
                  </p>
                </div>
              </div>
            );
          },
        }),
        violationColumn.accessor('severity', {
          header: t('common:labels.severity'),
          cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
        }),
        violationColumn.accessor('createdAt', {
          header: t('common:labels.when'),
          cell: ({ row }) => (
            <span className="text-muted-foreground text-sm">
              {formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
            </span>
          ),
        }),
        // Display, not accessor: the API has no `status` sort field, so a
        // sortable header here would silently drop back to the default order.
        violationColumn.display({
          id: 'status',
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
        violationColumn.display({
          id: 'actions',
          header: '',
          cell: ({ row }) => {
            const violation = row.original;
            return (
              <div
                className="flex items-center gap-2"
                onClick={(e) => {
                  e.stopPropagation();
                }}
              >
                {!violation.acknowledgedAt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      acknowledge(violation.id);
                    }}
                    disabled={isAcknowledging}
                    className="text-green-600 hover:text-green-700 dark:text-green-500 dark:hover:text-green-400"
                  >
                    <Check className="mr-1 h-4 w-4" />
                    {t('common:actions.acknowledge')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDismissId(violation.id);
                  }}
                  className="text-destructive hover:text-destructive"
                >
                  <X className="mr-1 h-4 w-4" />
                  {t('common:actions.dismiss')}
                </Button>
              </div>
            );
          },
        }),
      ]),
    [t, acknowledge, isAcknowledging, isMultiServer, selectedServers, handleAddPersonToFilter]
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

  const { table, pager } = useDataTable<ViolationWithDetails>({
    columns,
    data: rows,
    getRowId: getViolationId,
    pageSize: PAGE_SIZE,
    pageCount,
    page,
    onPageChange: setPage,
    sorting,
    onSortingChange: handleSortingChange,
    selection,
  });

  const hasActiveFilters = countActiveFilters(descriptors, filters) > 0;
  const dismissCount = selectAllMode ? total : selectedCount;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">{t('pages:violations.title')}</h1>
        <p className="text-muted-foreground text-sm">
          {t('common:count.violation', { count: total })}
        </p>
      </div>

      {/* Person filter summary: one card when reading a single person's record,
          a compact combined strip when several are selected. */}
      {selectedPeople.length === 1 && selectedPeople[0] && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
            <div className="flex items-center gap-3">
              <Avatar className="h-10 w-10">
                <AvatarImage
                  src={
                    getAvatarUrl(selectedPeople[0].serverId, selectedPeople[0].thumbUrl, 40) ??
                    undefined
                  }
                />
                <AvatarFallback>
                  {(selectedPeople[0].identityName ??
                    selectedPeople[0].username)[0]?.toUpperCase() ?? '?'}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="font-medium">
                  {selectedPeople[0].identityName ?? selectedPeople[0].username}
                </p>
                <p className="text-muted-foreground text-sm">
                  {t('common:count.violation', { count: total })}
                </p>
              </div>
            </div>
            {selectedPeople[0].identityServers && selectedPeople[0].identityServers.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedPeople[0].identityServers.map((server) => (
                  <ServerColumnCell key={server.id} server={server} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {selectedPeople.length > 1 && (
        <Card>
          <CardContent className="space-y-3 py-4">
            <div className="flex flex-wrap gap-3">
              {selectedPeople.map((person) => (
                <div
                  key={person.userId}
                  className="bg-muted/50 flex items-center gap-2 rounded-full py-1 pr-3 pl-1"
                >
                  <Avatar className="h-6 w-6">
                    <AvatarImage
                      src={getAvatarUrl(person.serverId, person.thumbUrl, 24) ?? undefined}
                    />
                    <AvatarFallback className="text-[10px]">
                      {(person.identityName ?? person.username)[0]?.toUpperCase() ?? '?'}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-sm font-medium">
                    {person.identityName ?? person.username}
                  </span>
                  {person.identityServers && person.identityServers.length > 0 && (
                    <div className="flex gap-1">
                      {person.identityServers.map((server) => (
                        <ServerColumnCell key={server.id} server={server} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className="text-muted-foreground text-sm">
              {t('common:count.violation', { count: total })}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-4">
          <FilterBar
            descriptors={barDescriptors}
            value={filters}
            onChange={applyFilters}
            defaults={VIOLATIONS_FILTER_DEFAULTS}
            labels={{
              trigger: t('common:labels.filters'),
              panelTitle: t('common:labels.filters'),
              clearAll: t('common:filters.clearAll'),
              done: t('common:filters.done'),
              removeFilter: (label: string) => t('common:filters.remove', { label }),
            }}
          >
            <label htmlFor={PEOPLE_FILTER_TRIGGER_ID} className="sr-only">
              {t('pages:violations.filterPeople')}
            </label>
            <PersonMultiSelectCombobox
              triggerId={PEOPLE_FILTER_TRIGGER_ID}
              value={selectedPeopleIds}
              onChange={handlePersonFilterChange}
              options={personOptions}
              onSearchChange={setPersonSearch}
              isLoading={personOptionsLoading}
              isError={personOptionsError}
              resolveExtraName={resolvePersonName}
              allLabel={t('pages:violations.allPeople')}
              countLabel={(count) => t('pages:violations.peopleSelectedCount', { count })}
              searchPlaceholder={t('pages:violations.personFilterPlaceholder')}
              emptyMessage={t('pages:violations.personFilterEmpty')}
              errorMessage={t('pages:violations.personFilterError')}
              loadingMessage={t('common:states.loading')}
            />
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
                    {t('pages:violations.selectAllViolations', { count: total })}
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
                    onRowClick={(violation) => {
                      void navigate(`/violations/${violation.id}`);
                    }}
                    empty={
                      <DataTableEmpty
                        table={table}
                        icon={AlertTriangle}
                        title={t('pages:violations.noViolationsFound')}
                        description={
                          hasActiveFilters
                            ? t('pages:violations.tryAdjustingFilters')
                            : t('pages:violations.noViolationsRecorded')
                        }
                      />
                    }
                    getRowStyle={
                      isMultiServer
                        ? (row) => {
                            const color = row.server?.id
                              ? (colorMap.get(row.server.id) ?? null)
                              : null;
                            return color ? { boxShadow: `inset 3px 0 0 0 ${color}` } : undefined;
                          }
                        : undefined
                    }
                  />
                </DataTableViewport>
                <DataTablePager
                  {...pager}
                  labels={{
                    navigation: t('common:table.pagination'),
                    status: t('common:table.pageOf', {
                      page: pager.page,
                      total: pager.pageCount,
                    }),
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
        open={dismissId !== null}
        onOpenChange={(open) => {
          if (!open) setDismissId(null);
        }}
        title={t('pages:violations.dismissViolation')}
        description={t('pages:violations.dismissViolationConfirm')}
        confirmLabel={t('common:actions.dismiss')}
        confirmLoadingLabel={t('common:states.dismissing')}
        cancelLabel={t('common:actions.cancel')}
        onConfirm={handleDismiss}
        isLoading={isDismissing}
      />

      <ConfirmDialog
        open={bulkDismissConfirmOpen}
        onOpenChange={setBulkDismissConfirmOpen}
        title={t('pages:violations.dismissViolation', { count: dismissCount })}
        description={t('pages:violations.dismissViolationsConfirm')}
        confirmLabel={t('pages:violations.dismissViolation', { count: dismissCount })}
        confirmLoadingLabel={t('common:states.dismissing')}
        cancelLabel={t('common:actions.cancel')}
        onConfirm={handleBulkDismiss}
        isLoading={bulkDismiss.isPending}
      />
    </div>
  );
}
