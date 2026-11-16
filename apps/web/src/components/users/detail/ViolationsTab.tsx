import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { formatDistanceToNow } from 'date-fns';
import { Bot, User as UserIcon, XCircle } from 'lucide-react';
import type { TerminationLogWithDetails, ViolationWithDetails } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
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
import { ServerColumnCell } from '@/components/server';
import { SeverityBadge } from '@/components/violations/SeverityBadge';
import { useUserTerminations, useViolations } from '@/hooks/queries';
import { getMediaDisplay } from '@/lib/utils';
import { usePagerLabels } from './usePagerLabels';

const PAGE_SIZE = 10;

const violationColumn = createDataTableColumnHelper<ViolationWithDetails>();
const terminationColumn = createDataTableColumnHelper<TerminationLogWithDetails>();
const getRowId = (row: { id: string }) => row.id;

interface ViolationsTabProps {
  /** The account the page is anchored on. */
  serverUserId: string;
  /** The person behind it, used unless the page is narrowed to one account. */
  identityUserId: string;
  isSpecificServerScope: boolean;
  scope: 'identity' | undefined;
  showServer: boolean;
}

export function ViolationsTab({
  serverUserId,
  identityUserId,
  isSpecificServerScope,
  scope,
  showServer,
}: ViolationsTabProps) {
  const { t } = useTranslation(['pages', 'common']);
  const [violationsPage, setViolationsPage] = useState(1);
  const [terminationsPage, setTerminationsPage] = useState(1);

  const violations = useViolations(
    isSpecificServerScope
      ? { serverUserId, page: violationsPage, pageSize: PAGE_SIZE }
      : { userId: identityUserId, page: violationsPage, pageSize: PAGE_SIZE }
  );
  const terminations = useUserTerminations(serverUserId, {
    page: terminationsPage,
    pageSize: PAGE_SIZE,
    scope,
  });

  const violationColumns = useMemo(
    () =>
      violationColumn.columns([
        violationColumn.accessor((violation) => violation.rule.name, {
          id: 'rule.name',
          header: t('common:labels.rule'),
          enableSorting: false,
          cell: ({ row }) => (
            <div>
              <Link to={`/violations/${row.original.id}`} className="font-medium hover:underline">
                {row.original.rule.name}
              </Link>
              <p className="text-muted-foreground text-xs capitalize">
                {row.original.rule.type?.replace(/_/g, ' ') ??
                  t('pages:automations.customAutomation')}
              </p>
            </div>
          ),
        }),
        ...(showServer
          ? [
              violationColumn.display({
                id: 'server',
                header: t('common:labels.server'),
                cell: ({ row }) =>
                  row.original.server ? <ServerColumnCell server={row.original.server} /> : null,
              }),
            ]
          : []),
        violationColumn.accessor('severity', {
          header: t('common:labels.severity'),
          enableSorting: false,
          cell: ({ row }) => (
            <SeverityBadge severity={row.original.severity as 'low' | 'warning' | 'high'} />
          ),
        }),
        violationColumn.accessor('createdAt', {
          header: t('common:labels.when'),
          enableSorting: false,
          cell: ({ row }) => (
            <span className="text-muted-foreground text-sm">
              {formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
            </span>
          ),
        }),
        violationColumn.accessor('acknowledgedAt', {
          header: t('common:labels.status'),
          enableSorting: false,
          cell: ({ row }) => (
            <span
              className={
                row.original.acknowledgedAt ? 'text-muted-foreground' : 'text-warning font-medium'
              }
            >
              {row.original.acknowledgedAt
                ? t('common:states.acknowledged')
                : t('common:states.pending')}
            </span>
          ),
        }),
      ]),
    [t, showServer]
  );

  const terminationColumns = useMemo(
    () =>
      terminationColumn.columns([
        terminationColumn.accessor('trigger', {
          header: t('common:labels.type'),
          enableSorting: false,
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
          enableSorting: false,
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
        ...(showServer
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
          enableSorting: false,
          cell: ({ row }) => (
            <span className="text-muted-foreground text-sm">
              {formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
            </span>
          ),
        }),
        terminationColumn.accessor('triggeredByUsername', {
          header: t('pages:userDetail.byRule'),
          enableSorting: false,
          cell: ({ row }) => {
            const log = row.original;
            if (log.trigger === 'manual') {
              return (
                <span className="text-sm">
                  {log.triggeredByUsername ?? t('common:labels.unknown')}
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
          enableSorting: false,
          cell: ({ row }) => (
            <span className="text-muted-foreground block max-w-[150px] truncate text-sm">
              {row.original.reason ?? '—'}
            </span>
          ),
        }),
        terminationColumn.accessor('success', {
          header: t('common:labels.status'),
          enableSorting: false,
          cell: ({ row }) => (
            <span
              className={row.original.success ? 'text-success' : 'text-destructive font-medium'}
            >
              {row.original.success ? t('common:states.success') : t('common:states.failed')}
            </span>
          ),
        }),
      ]),
    [t, showServer]
  );

  const { table: violationsTable, pager: violationsPager } = useDataTable<ViolationWithDetails>({
    columns: violationColumns,
    data: violations.data?.data ?? [],
    getRowId,
    pageSize: PAGE_SIZE,
    pageCount: Math.ceil((violations.data?.meta.total ?? 0) / PAGE_SIZE),
    page: violationsPage,
    onPageChange: setViolationsPage,
  });

  const { table: terminationsTable, pager: terminationsPager } =
    useDataTable<TerminationLogWithDetails>({
      columns: terminationColumns,
      data: terminations.data?.data ?? [],
      getRowId,
      pageSize: PAGE_SIZE,
      pageCount: Math.ceil((terminations.data?.total ?? 0) / PAGE_SIZE),
      page: terminationsPage,
      onPageChange: setTerminationsPage,
    });

  const violationsLabels = usePagerLabels(violationsPager.page, violationsPager.pageCount);
  const terminationsLabels = usePagerLabels(terminationsPager.page, terminationsPager.pageCount);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('pages:userDetail.violations')}</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTableRoot>
            <DataTableViewport flush>
              <DataTableHeader table={violationsTable} />
              <DataTableBody
                table={violationsTable}
                isLoading={violations.isLoading}
                loadingLabel={t('common:states.loading')}
                empty={
                  <DataTableEmpty
                    table={violationsTable}
                    title={t('pages:userDetail.noViolationsFound')}
                  />
                }
              />
            </DataTableViewport>
            <DataTablePager variant="footer" {...violationsPager} labels={violationsLabels} />
          </DataTableRoot>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <XCircle className="h-5 w-5" />
            {t('pages:userDetail.terminationHistory')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTableRoot>
            <DataTableViewport flush>
              <DataTableHeader table={terminationsTable} />
              <DataTableBody
                table={terminationsTable}
                isLoading={terminations.isLoading}
                loadingLabel={t('common:states.loading')}
                empty={
                  <DataTableEmpty
                    table={terminationsTable}
                    title={t('pages:userDetail.noTerminationsFound')}
                  />
                }
              />
            </DataTableViewport>
            <DataTablePager variant="footer" {...terminationsPager} labels={terminationsLabels} />
          </DataTableRoot>
        </CardContent>
      </Card>
    </div>
  );
}
