import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';
import type { RequesterFollowThrough } from '@tracearr/shared';
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
import { InlineErrorState } from '@/components/library/ErrorState';
import { UserCell } from '@/components/users/UserCell';
import { formatDuration } from '@/lib/formatters';

interface RequesterFollowThroughTableProps {
  rows: RequesterFollowThrough[] | undefined;
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  sorting: SortingState;
  onSortingChange: (sorting: SortingState) => void;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

const columnHelper = createDataTableColumnHelper<RequesterFollowThrough>();

function rowId(row: RequesterFollowThrough): string {
  return row.requester.serverUserId ?? `${row.requester.serverId}:${row.requester.username}`;
}

export function RequesterFollowThroughTable({
  rows,
  total,
  page,
  pageSize,
  onPageChange,
  sorting,
  onSortingChange,
  isLoading,
  isError,
  onRetry,
}: RequesterFollowThroughTableProps) {
  const { t } = useTranslation(['pages', 'common']);

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor((row) => row.requester.identityName ?? row.requester.username, {
          id: 'name',
          header: t('pages:requests.followThrough.person'),
          cell: (info) => {
            const { requester } = info.row.original;
            return (
              <UserCell
                serverUserId={requester.serverUserId}
                username={requester.username}
                identityName={requester.identityName}
                thumbUrl={requester.thumb}
                serverId={requester.serverId}
              />
            );
          },
        }),
        columnHelper.accessor((row) => row.requested, {
          id: 'requested',
          header: t('pages:requests.followThrough.asked'),
          meta: { numeric: true },
        }),
        columnHelper.accessor((row) => row.landed, {
          id: 'landed',
          header: t('pages:requests.followThrough.landed'),
          meta: { numeric: true },
        }),
        columnHelper.accessor((row) => row.watched, {
          id: 'watched',
          header: t('pages:requests.followThrough.watched'),
          meta: { numeric: true },
        }),
        columnHelper.accessor((row) => row.watchedByOthers, {
          id: 'watchedByOthers',
          header: t('pages:requests.followThrough.watchedByOthers'),
          meta: { numeric: true },
        }),
        columnHelper.accessor((row) => row.medianWaitMs, {
          id: 'medianWaitMs',
          header: t('pages:requests.followThrough.medianWait'),
          meta: { numeric: true },
          cell: (info) => {
            const wait = info.row.original.medianWaitMs;
            return wait === null ? '—' : formatDuration(wait, { style: 'compactDays' });
          },
        }),
      ]),
    [t]
  );

  const { table, pager } = useDataTable<RequesterFollowThrough>({
    columns,
    data: rows,
    getRowId: rowId,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    page,
    onPageChange,
    sorting,
    onSortingChange,
  });

  if (isError) {
    return (
      <InlineErrorState
        message={t('pages:requests.followThrough.failedToLoad')}
        onRetry={onRetry}
      />
    );
  }

  return (
    <DataTableRoot density="default">
      <DataTableViewport flush>
        <DataTableHeader table={table} />
        <DataTableBody
          table={table}
          isLoading={isLoading}
          loadingLabel={t('common:states.loading')}
          empty={
            <DataTableEmpty
              table={table}
              icon={Users}
              title={t('pages:requests.followThrough.emptyTitle')}
              description={t('pages:requests.followThrough.emptyDescription')}
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
  );
}
