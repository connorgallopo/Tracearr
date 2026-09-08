import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDistanceToNow } from 'date-fns';
import { Activity } from 'lucide-react';
import type { Automation, AutomationRunSummary, RunOutcome } from '@tracearr/shared';
import { contextOf, contextSupplies, listPageCount } from '@tracearr/shared';
import { EvaluationsList } from '@/components/automations/EvaluationsList';
import { SELECTED_TOGGLE } from '@/components/automations/builder/selection';
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { UserCell } from '@/components/users/UserCell';
import { SeverityBadge } from '@/components/violations/SeverityBadge';
import { useAutomationRuns, useRunCounts } from '@/hooks/queries/useRuns';
import { ranActionLabel, runWhere, runWho, type Translate } from '@/lib/automations';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;

const columnHelper = createDataTableColumnHelper<AutomationRunSummary>();
const getRunId = (run: AutomationRunSummary) => run.id;

const OUTCOME_DOT: Record<RunOutcome, string> = {
  completed: 'bg-primary',
  stopped_by_condition: 'bg-muted-foreground',
  error: 'bg-destructive',
};

/**
 * The outcome filter the API already takes, plus everything. A toggle group rather than
 * tabs: these switch one table's rows, they do not switch between panels.
 */
const OUTCOME_TABS = ['completed', 'stopped_by_condition', 'error', 'all'] as const;
type OutcomeTab = (typeof OUTCOME_TABS)[number];

const isOutcomeTab = (value: string): value is OutcomeTab =>
  (OUTCOME_TABS as readonly string[]).includes(value);

interface ActivityListProps {
  automation: Automation;
  onSelectRun: (runId: string) => void;
}

export function ActivityList({ automation, onSelectRun }: ActivityListProps) {
  const { id: automationId, kind } = automation;
  const { t } = useTranslation(['pages', 'common']);
  const [page, setPage] = useState(1);
  // Runs that did something are what the page is for; the rest are one click away.
  const [tab, setTab] = useState<OutcomeTab>('completed');

  const { data, isLoading } = useAutomationRuns(automationId, {
    page,
    pageSize: PAGE_SIZE,
    outcome: tab === 'all' ? undefined : tab,
  });
  const { data: counts } = useRunCounts(automationId);
  const rows = data?.data;
  const pageCount = data ? listPageCount(data.meta) : 1;
  // The empty Ran tab reports the no-match count, so that is the number it gates on.
  const onlyNonMatches =
    tab === 'completed' && counts !== undefined && counts.stopped_by_condition > 0;

  // What the triggers watch decides whether there can be a person, an item, or neither.
  const context = contextOf(automation.triggers);
  const subjectColumn =
    context === null
      ? null
      : contextSupplies(context, 'account')
        ? 'who'
        : context === 'media'
          ? 'item'
          : null;

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor('outcome', {
          header: t('pages:automations.activity.outcome'),
          cell: ({ row }) => (
            <span className="flex items-center gap-2 whitespace-nowrap">
              <span
                aria-hidden="true"
                className={cn('size-2 shrink-0 rounded-full', OUTCOME_DOT[row.original.outcome])}
              />
              {t(`pages:automations.activity.outcomes.${row.original.outcome}`)}
            </span>
          ),
        }),
        columnHelper.accessor('humanSummary', {
          header: t('pages:automations.activity.summary'),
          cell: ({ row }) => <SummaryCell run={row.original} />,
        }),
        ...(subjectColumn === 'who'
          ? [
              columnHelper.accessor('subject', {
                id: 'who',
                header: t('pages:automations.activity.who'),
                cell: ({ row }) => (
                  <UserCell
                    serverUserId={row.original.serverUserId}
                    username={row.original.subject.name}
                    identityName={row.original.subject.personName}
                    thumbUrl={row.original.subject.thumbUrl}
                    serverId={row.original.serverId}
                    showUsername
                  />
                ),
              }),
            ]
          : []),
        ...(subjectColumn === 'item'
          ? [
              columnHelper.accessor('subject', {
                id: 'item',
                header: t('pages:automations.activity.item'),
                cell: ({ row }) => <Named name={runWho(row.original.subject)} />,
              }),
            ]
          : []),
        columnHelper.accessor('subject', {
          id: 'where',
          header: t('pages:automations.activity.where'),
          cell: ({ row }) => <Named name={runWhere(row.original.subject)} />,
        }),
        ...(kind === 'policy'
          ? [
              columnHelper.accessor('severity', {
                header: t('common:labels.severity'),
                cell: ({ row }) =>
                  row.original.severity ? (
                    <SeverityBadge severity={row.original.severity} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  ),
              }),
            ]
          : []),
        columnHelper.accessor('startedAt', {
          header: t('pages:automations.activity.started'),
          cell: ({ row }) => (
            <span className="text-muted-foreground whitespace-nowrap">
              {formatDistanceToNow(new Date(row.original.startedAt), { addSuffix: true })}
            </span>
          ),
        }),
      ]),
    [t, kind, subjectColumn]
  );

  const { table, pager } = useDataTable<AutomationRunSummary>({
    columns,
    data: rows,
    getRowId: getRunId,
    pageSize: PAGE_SIZE,
    pageCount,
    page,
    onPageChange: setPage,
  });

  return (
    <div className="space-y-4">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={tab}
        aria-label={t('pages:automations.activity.tabsLabel')}
        onValueChange={(next) => {
          if (!isOutcomeTab(next)) return;
          setTab(next);
          setPage(1);
        }}
      >
        {OUTCOME_TABS.map((value) => (
          <ToggleGroupItem key={value} value={value} className={SELECTED_TOGGLE}>
            {t(`pages:automations.activity.tabs.${value}`)}
            {counts && (
              <span className="text-muted-foreground text-xs tabular-nums">
                {value === 'all' ? counts.total : counts[value]}
              </span>
            )}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <DataTableRoot density="default">
        <DataTableViewport flush>
          <DataTableHeader table={table} />
          <DataTableBody
            table={table}
            isLoading={isLoading}
            loadingLabel={t('common:states.loading')}
            onRowClick={(run) => onSelectRun(run.id)}
            empty={
              <DataTableEmpty
                table={table}
                icon={Activity}
                title={t(
                  onlyNonMatches
                    ? 'pages:automations.activity.emptyRan'
                    : 'pages:automations.activity.empty'
                )}
                description={
                  onlyNonMatches
                    ? t('pages:automations.activity.emptyRanDescription', {
                        count: counts.stopped_by_condition,
                      })
                    : t('pages:automations.activity.emptyDescription')
                }
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

      <EvaluationsList automationId={automationId} />
    </div>
  );
}

/**
 * What a run that ran did: the violation it recorded, then every action that
 * succeeded. Null while the step log is still being appended, and for the rest.
 */
function ranSummary(t: Translate, run: AutomationRunSummary): string | null {
  if (run.outcome !== 'completed') return null;
  const parts = run.kind === 'policy' ? [t('automations.activity.recordedViolation')] : [];
  for (const action of run.ranActions) {
    const label = ranActionLabel(t, action);
    if (label !== undefined) parts.push(label);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/** What the run did if it did anything, and what it read if it did not. */
function SummaryCell({ run }: { run: AutomationRunSummary }) {
  const { t } = useTranslation('pages');
  return (
    <span className="line-clamp-2 text-sm">
      {ranSummary(t, run) ?? run.humanSummary ?? t('automations.activity.noSummary')}
    </span>
  );
}

/** A joined name, or a dash where the row it named is gone or was never there. */
function Named({ name }: { name: string | null }) {
  if (!name) return <span className="text-muted-foreground">—</span>;
  return <span className="truncate">{name}</span>;
}
