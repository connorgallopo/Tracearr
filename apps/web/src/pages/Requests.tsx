import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { HardDrive, Inbox, CheckCircle2, PlugZap } from 'lucide-react';
import type { RequesterSort, RequestUnplayedSort } from '@tracearr/shared';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/library';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { RequestFunnelChart } from '@/components/charts';
import { RequestOutcomeTable } from '@/components/requests/RequestOutcomeTable';
import { RequesterFollowThroughTable } from '@/components/requests/RequesterFollowThroughTable';
import type { SortingState } from '@/components/ui/data-table';
import {
  useRequesters,
  useRequestsAnalytics,
  useRequestsConfigured,
  useRequestsUnplayed,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { formatBytes, formatPercent } from '@/lib/formatters';

const PAGE_SIZE = 20;

function sortParams<T extends string>(sorting: SortingState, fallback: T) {
  const active = sorting[0];
  return {
    sortBy: (active?.id ?? fallback) as T,
    sortOrder: active?.desc === false ? ('asc' as const) : ('desc' as const),
  };
}

export function Requests() {
  const { t } = useTranslation('pages');
  const { selectedServerIds } = useServer();
  const status = useRequestsConfigured();
  const configured = status.data?.configured ?? false;

  const [unplayedPage, setUnplayedPage] = useState(1);
  const [unplayedSorting, setUnplayedSorting] = useState<SortingState>([
    { id: 'fileSizeBytes', desc: true },
  ]);
  const [requesterPage, setRequesterPage] = useState(1);
  const [requesterSorting, setRequesterSorting] = useState<SortingState>([
    { id: 'watched', desc: true },
  ]);

  const analytics = useRequestsAnalytics(selectedServerIds, { enabled: configured });
  const unplayed = useRequestsUnplayed(selectedServerIds, {
    page: unplayedPage,
    pageSize: PAGE_SIZE,
    enabled: configured,
    ...sortParams<RequestUnplayedSort>(unplayedSorting, 'fileSizeBytes'),
  });
  const requesters = useRequesters(selectedServerIds, {
    page: requesterPage,
    pageSize: PAGE_SIZE,
    enabled: configured,
    ...sortParams<RequesterSort>(requesterSorting, 'watched'),
  });

  const data = analytics.data;
  const landed = data?.funnel.landed ?? 0;
  const isLoading = status.isLoading || analytics.isLoading;
  const shareOfLanded = (count: number) =>
    landed === 0 ? '—' : formatPercent(count / landed, 0, true);

  const onUnplayedSort = (sorting: SortingState) => {
    setUnplayedSorting(sorting);
    setUnplayedPage(1);
  };
  const onRequesterSort = (sorting: SortingState) => {
    setRequesterSorting(sorting);
    setRequesterPage(1);
  };

  const header = (
    <div>
      <h1 className="text-2xl font-bold">{t('requests.page.title')}</h1>
      <p className="text-muted-foreground text-sm">{t('requests.page.description')}</p>
    </div>
  );

  if (status.isSuccess && !configured) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={PlugZap}
          title={t('requests.page.notConfigured')}
          description={t('requests.page.notConfiguredDescription')}
        >
          <Button asChild variant="outline">
            <Link to="/settings/servers/connections">{t('requests.page.linkSeerr')}</Link>
          </Button>
        </EmptyState>
      </div>
    );
  }

  if (analytics.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title={t('requests.page.failedToLoad')}
          message={analytics.error.message}
          onRetry={() => void analytics.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          icon={Inbox}
          label={t('requests.page.kpi.requested')}
          value={data?.funnel.requested ?? 0}
          subValue={t('requests.page.kpi.landedOf', { count: landed })}
          isLoading={isLoading}
        />
        <StatCard
          icon={CheckCircle2}
          label={t('requests.page.kpi.watched')}
          value={data?.funnel.watched ?? 0}
          subValue={t('requests.page.kpi.ofLanded', {
            share: shareOfLanded(data?.funnel.watched ?? 0),
          })}
          isLoading={isLoading}
        />
        <StatCard
          icon={HardDrive}
          label={t('requests.page.kpi.neverPlayed')}
          value={data?.unplayed.count ?? 0}
          subValue={t('requests.page.kpi.onDisk', {
            size: formatBytes(data?.unplayed.bytes ?? 0),
          })}
          isLoading={isLoading}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('requests.funnel.title')}</CardTitle>
          <CardDescription>{t('requests.funnel.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <RequestFunnelChart
            stages={[
              { name: t('requests.funnel.requested'), value: data?.funnel.requested ?? 0 },
              { name: t('requests.funnel.landed'), value: landed },
              { name: t('requests.funnel.watched'), value: data?.funnel.watched ?? 0 },
            ]}
            isLoading={isLoading}
            emptyMessage={t('requests.funnel.empty')}
            formatShare={(count, total) => t('requests.funnel.share', { count, total })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('requests.unplayed.title')}</CardTitle>
          <CardDescription>{t('requests.unplayed.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <RequestOutcomeTable
            rows={unplayed.data?.data}
            total={unplayed.data?.total ?? 0}
            page={unplayedPage}
            pageSize={PAGE_SIZE}
            onPageChange={setUnplayedPage}
            sorting={unplayedSorting}
            onSortingChange={onUnplayedSort}
            isLoading={unplayed.isLoading}
            isError={unplayed.isError}
            onRetry={() => void unplayed.refetch()}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('requests.followThrough.title')}</CardTitle>
          <CardDescription>{t('requests.followThrough.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <RequesterFollowThroughTable
            rows={requesters.data?.data}
            total={requesters.data?.total ?? 0}
            page={requesterPage}
            pageSize={PAGE_SIZE}
            onPageChange={setRequesterPage}
            sorting={requesterSorting}
            onSortingChange={onRequesterSort}
            isLoading={requesters.isLoading}
            isError={requesters.isError}
            onRetry={() => void requesters.refetch()}
          />
        </CardContent>
      </Card>
    </div>
  );
}
