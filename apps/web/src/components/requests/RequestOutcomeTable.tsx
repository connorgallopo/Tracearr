import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Film, Tv } from 'lucide-react';
import type { RequestOutcomeRow } from '@tracearr/shared';
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
import { formatSeasons, formatWait, type Translate } from '@/components/requests/format';
import { formatBytes } from '@/lib/formatters';

interface RequestOutcomeTableProps {
  rows: RequestOutcomeRow[] | undefined;
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

const columnHelper = createDataTableColumnHelper<RequestOutcomeRow>();

function TitleCell({ row }: { row: RequestOutcomeRow }) {
  const { t } = useTranslation('pages');
  const Icon = row.mediaType === 'show' ? Tv : Film;
  const seasons = formatSeasons(row.seasons, t as Translate);
  const label = row.title ?? t('requests.outcomes.untitled');

  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon aria-hidden="true" className="text-muted-foreground size-3.5 shrink-0" />
      <span className="min-w-0">
        {row.mediaId ? (
          <Link className="truncate font-medium hover:underline" to={`/media/${row.mediaId}`}>
            {label}
          </Link>
        ) : (
          <span className="truncate font-medium">{label}</span>
        )}
        {(row.year !== null || seasons !== null) && (
          <span className="text-muted-foreground block text-xs">
            {[row.year, seasons].filter(Boolean).join(' · ')}
          </span>
        )}
      </span>
    </span>
  );
}

export function RequestOutcomeTable({
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
}: RequestOutcomeTableProps) {
  const { t } = useTranslation(['pages', 'common']);

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor((row) => row.title, {
          id: 'title',
          header: t('pages:requests.outcomes.title'),
          cell: (info) => <TitleCell row={info.row.original} />,
        }),
        columnHelper.display({
          id: 'requester',
          header: t('pages:requests.outcomes.requester'),
          enableSorting: false,
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
        columnHelper.accessor((row) => row.waitMs, {
          id: 'waitMs',
          header: t('pages:requests.outcomes.wait'),
          meta: { numeric: true },
          cell: (info) => formatWait(info.row.original.waitMs, 'completed', t as Translate),
        }),
        columnHelper.accessor((row) => row.requestedAt, {
          id: 'requestedAt',
          header: t('pages:requests.outcomes.requested'),
          meta: { numeric: true },
          cell: (info) => new Date(info.row.original.requestedAt).toLocaleDateString(),
        }),
        columnHelper.accessor((row) => row.fileSizeBytes, {
          id: 'fileSizeBytes',
          header: t('pages:requests.outcomes.onDisk'),
          meta: { numeric: true },
          cell: (info) => formatBytes(info.row.original.fileSizeBytes),
        }),
      ]),
    [t]
  );

  const { table, pager } = useDataTable<RequestOutcomeRow>({
    columns,
    data: rows,
    getRowId: (row) => row.id,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    page,
    onPageChange,
    sorting,
    onSortingChange,
  });

  if (isError) {
    return (
      <InlineErrorState message={t('pages:requests.outcomes.failedToLoad')} onRetry={onRetry} />
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
              icon={Film}
              title={t('pages:requests.unplayed.emptyTitle')}
              description={t('pages:requests.unplayed.emptyDescription')}
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
