import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ServerUserFullDetail, SessionWithDetails, UserRangeStats } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { TimeRangePeriod } from '@/components/ui/time-range-picker';
import { PlaysChart, priorRangeComparison } from '@/components/charts/PlaysChart';
import { MostFinishedCard } from './MostFinishedCard';
import { UserSessionsTable } from './SessionsTab';
import { WhatCard } from './WhatCard';
import { WhenCard } from './WhenCard';
import { WhereCard } from './WhereCard';

const RECENT_SESSIONS = 5;

interface OverviewTabProps {
  stats: UserRangeStats | undefined;
  isLoading: boolean;
  period: TimeRangePeriod;
  detail: ServerUserFullDetail;
  showServer: boolean;
  onSessionClick: (session: SessionWithDetails) => void;
  onShowSessions: () => void;
}

export function OverviewTab({
  stats,
  isLoading,
  period,
  detail,
  showServer,
  onSessionClick,
  onShowSessions,
}: OverviewTabProps) {
  const { t } = useTranslation(['pages', 'common']);

  const comparisons = useMemo(() => {
    if (!stats) return [];
    return [
      ...(stats.priorPlaysByDay.length > 0
        ? [
            priorRangeComparison(
              t('pages:userDetail.overview.priorRange'),
              stats.priorPlaysByDay,
              stats.playsByDay
            ),
          ]
        : []),
      ...(stats.serverAvgPlaysByDay.length > 0
        ? [
            {
              name: t('pages:userDetail.overview.serverAverage'),
              data: stats.serverAvgPlaysByDay,
              color: 'oklch(var(--primary))',
            },
          ]
        : []),
    ];
  }, [stats, t]);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>{t('pages:userDetail.overview.playsOverTime')}</CardTitle>
          </CardHeader>
          <CardContent>
            <PlaysChart
              data={stats?.playsByDay}
              isLoading={isLoading}
              period={period}
              height={240}
              comparisons={comparisons}
            />
          </CardContent>
        </Card>
        <WhenCard stats={stats} isLoading={isLoading} className="lg:col-span-2" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <WhatCard stats={stats} />
        <MostFinishedCard items={stats?.mostFinished} />
        <WhereCard
          devices={stats?.devices}
          locations={stats?.locations}
          localShare={stats?.localShare}
          allDevices={detail.devices}
          allLocations={detail.locations}
          totalSessions={detail.sessions.total}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('common:labels.recentSessions')}</CardTitle>
          <CardAction>
            <Button variant="link" size="sm" className="h-auto px-0" onClick={onShowSessions}>
              {t('pages:userDetail.overview.allSessions')}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <UserSessionsTable
            sessions={detail.sessions.data.slice(0, RECENT_SESSIONS)}
            user={detail.user}
            personName={detail.user.identityName ?? detail.identity.username}
            showServer={showServer}
            onSessionClick={onSessionClick}
          />
        </CardContent>
      </Card>
    </div>
  );
}
