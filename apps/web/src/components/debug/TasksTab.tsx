import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { RefreshCw, Activity, Clock, AlertCircle, CheckCircle2, Cpu, Radio } from 'lucide-react';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatInterval } from '@/lib/dateFormat';
import { cn } from '@/lib/utils';
import { debugFetch } from '@/lib/debugFetch';

interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  dlqSize?: number;
  schedule?: string | null;
}

interface TrackedService {
  name: string;
  description: string;
  intervalMs: number;
  running: boolean;
}

interface TasksData {
  queues: {
    notifications: QueueStats | null;
    imports: QueueStats | null;
    maintenance: QueueStats | null;
    librarySync: QueueStats | null;
    versionCheck: QueueStats | null;
    inactivityCheck: QueueStats | null;
    backup: QueueStats | null;
  };
  services: TrackedService[];
  publicEventConnections: { open: number; byUser: Record<string, number> };
  timestamp: string;
}

const QUEUE_INFO = [
  {
    key: 'notifications',
    nameKey: 'debug.tasksTab.queues.notifications',
    descriptionKey: 'debug.tasksTab.queues.notificationsDesc',
    hasDlq: true,
  },
  {
    key: 'imports',
    nameKey: 'debug.tasksTab.queues.imports',
    descriptionKey: 'debug.tasksTab.queues.importsDesc',
    hasDlq: true,
  },
  {
    key: 'maintenance',
    nameKey: 'debug.tasksTab.queues.maintenance',
    descriptionKey: 'debug.tasksTab.queues.maintenanceDesc',
  },
  {
    key: 'librarySync',
    nameKey: 'debug.tasksTab.queues.librarySync',
    descriptionKey: 'debug.tasksTab.queues.librarySyncDesc',
  },
  {
    key: 'versionCheck',
    nameKey: 'debug.tasksTab.queues.versionCheck',
    descriptionKey: 'debug.tasksTab.queues.versionCheckDesc',
  },
  {
    key: 'inactivityCheck',
    nameKey: 'debug.tasksTab.queues.inactivityCheck',
    descriptionKey: 'debug.tasksTab.queues.inactivityCheckDesc',
  },
  {
    key: 'backup',
    nameKey: 'debug.tasksTab.queues.backup',
    descriptionKey: 'debug.tasksTab.queues.backupDesc',
  },
] as const satisfies ReadonlyArray<{
  key: keyof TasksData['queues'];
  nameKey: string;
  descriptionKey: string;
  hasDlq?: boolean;
}>;

type Translate = TFunction<['pages', 'common']>;

/**
 * Format a schedule from BullMQ into a human-readable string.
 * Handles cron patterns (e.g. "10 *\/12 * * *") and "every Nms" intervals.
 */
function formatSchedule(schedule: string, t: Translate): string {
  // Handle "every Nms" format
  const everyMatch = schedule.match(/^every (\d+)ms$/);
  if (everyMatch?.[1]) {
    const ms = parseInt(everyMatch[1], 10);
    return t('debug.tasksTab.every', {
      interval: formatInterval(ms, t('debug.tasksTab.eventDriven')),
    });
  }

  // Handle common cron patterns
  const cronMatch = schedule.match(/^\d+\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (cronMatch?.[1]) {
    const hours = parseInt(cronMatch[1], 10);
    return t('debug.tasksTab.every', { interval: `${hours}h` });
  }

  return schedule;
}

export function TasksTab() {
  const { t } = useTranslation(['pages', 'common']);
  const tasks = useQuery({
    queryKey: ['debug', 'tasks'],
    queryFn: () => debugFetch<TasksData>('/tasks'),
    refetchInterval: 10_000,
  });

  if (tasks.isLoading) {
    return <p className="text-muted-foreground text-sm">{t('debug.tasksTab.loading')}</p>;
  }

  if (tasks.isError || !tasks.data) {
    return <p className="text-destructive text-sm">{t('debug.tasksTab.failedToLoad')}</p>;
  }

  const { queues, services, publicEventConnections } = tasks.data;

  return (
    <div className="space-y-6">
      {/* BullMQ Queues */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            {t('debug.tasksTab.jobQueues')}
          </CardTitle>
          <CardDescription>{t('debug.tasksTab.jobQueuesDesc')}</CardDescription>
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => tasks.refetch()}
              disabled={tasks.isFetching}
            >
              <RefreshCw className={cn('h-4 w-4', tasks.isFetching && 'animate-spin')} />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-left text-xs">
                  <th className="pr-4 pb-2 font-medium">{t('common:labels.name')}</th>
                  <th className="pr-4 pb-2 font-medium">{t('debug.tasksTab.description')}</th>
                  <th className="pr-4 pb-2 font-medium">{t('debug.tasksTab.schedule')}</th>
                  <th className="pr-2 pb-2 text-right font-medium">{t('common:tasks.waiting')}</th>
                  <th className="pr-2 pb-2 text-right font-medium">{t('common:states.active')}</th>
                  <th className="pr-2 pb-2 text-right font-medium">
                    {t('debug.tasksTab.completed')}
                  </th>
                  <th className="pr-2 pb-2 text-right font-medium">{t('common:states.failed')}</th>
                  <th className="pb-2 text-right font-medium">{t('debug.tasksTab.scheduled')}</th>
                </tr>
              </thead>
              <tbody>
                {QUEUE_INFO.map((info) => {
                  const stats = queues[info.key];
                  const isActive = stats ? stats.active > 0 : false;
                  const hasFailed = stats ? stats.failed > 0 : false;
                  const hasDlqItems = 'hasDlq' in info && (stats?.dlqSize ?? 0) > 0;

                  return (
                    <tr key={info.key} className="border-b last:border-0">
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{t(info.nameKey)}</span>
                          {isActive && (
                            <Badge variant="default" className="gap-1 px-1.5 py-0">
                              <Cpu className="h-2.5 w-2.5" />
                              {t('debug.tasksTab.processing')}
                            </Badge>
                          )}
                          {(hasFailed || hasDlqItems) && (
                            <Badge variant="danger" className="gap-1 px-1.5 py-0">
                              <AlertCircle className="h-2.5 w-2.5" />
                              {hasDlqItems
                                ? t('debug.tasksTab.dlq', { count: stats?.dlqSize ?? 0 })
                                : t('common:states.failed')}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="text-muted-foreground py-2.5 pr-4">
                        {t(info.descriptionKey)}
                      </td>
                      <td className="text-muted-foreground py-2.5 pr-4">
                        {stats?.schedule
                          ? formatSchedule(stats.schedule, t)
                          : t('debug.tasksTab.onDemand')}
                      </td>
                      {stats ? (
                        <>
                          <td className="py-2.5 pr-2 text-right tabular-nums">{stats.waiting}</td>
                          <td
                            className={cn(
                              'py-2.5 pr-2 text-right tabular-nums',
                              isActive && 'text-primary font-medium'
                            )}
                          >
                            {stats.active}
                          </td>
                          <td className="py-2.5 pr-2 text-right tabular-nums">
                            {stats.completed.toLocaleString()}
                          </td>
                          <td
                            className={cn(
                              'py-2.5 pr-2 text-right tabular-nums',
                              hasFailed && 'text-destructive font-medium'
                            )}
                          >
                            {stats.failed}
                          </td>
                          <td className="py-2.5 text-right tabular-nums">{stats.delayed}</td>
                        </>
                      ) : (
                        <td colSpan={5} className="text-muted-foreground py-2.5 text-center">
                          {t('debug.tasksTab.notInitialized')}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Interval Services */}
      {services.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              {t('debug.tasksTab.backgroundServices')}
            </CardTitle>
            <CardDescription>{t('debug.tasksTab.backgroundServicesDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-left text-xs">
                    <th className="pr-4 pb-2 font-medium">{t('common:labels.name')}</th>
                    <th className="pr-4 pb-2 font-medium">{t('debug.tasksTab.description')}</th>
                    <th className="pr-4 pb-2 font-medium">{t('debug.tasksTab.interval')}</th>
                    <th className="pb-2 font-medium">{t('common:labels.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {services.map((service) => (
                    <tr key={service.name} className="border-b last:border-0">
                      <td className="py-2.5 pr-4 font-medium">{service.name}</td>
                      <td className="text-muted-foreground py-2.5 pr-4">{service.description}</td>
                      <td className="text-muted-foreground py-2.5 pr-4">
                        {formatInterval(service.intervalMs, t('debug.tasksTab.eventDriven'))}
                      </td>
                      <td className="py-2.5">
                        {service.running ? (
                          <Badge variant="success" className="gap-1 text-xs">
                            <CheckCircle2 className="h-3 w-3" />
                            {t('common:tasks.running')}
                          </Badge>
                        ) : (
                          <Badge variant="danger" className="gap-1 text-xs">
                            <AlertCircle className="h-3 w-3" />
                            {t('common:labels.stopped')}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Radio className="h-5 w-5" />
            {t('debug.tasksTab.eventConnections')}
          </CardTitle>
          <CardDescription>{t('debug.tasksTab.eventConnectionsDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tabular-nums">{publicEventConnections.open}</p>
          {Object.keys(publicEventConnections.byUser).length > 1 && (
            <ul className="text-muted-foreground mt-2 space-y-1 text-sm">
              {Object.entries(publicEventConnections.byUser).map(([userId, count]) => (
                <li key={userId} className="font-mono">
                  {userId}: {count}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
