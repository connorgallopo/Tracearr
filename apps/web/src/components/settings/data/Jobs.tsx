import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Item,
  ItemGroup,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from '@/components/ui/item';
import {
  Wrench,
  Play,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  AlertTriangle,
  Database,
  ArrowUpDown,
  RefreshCw,
  Globe,
  Calendar,
  Library,
  Trash2,
  CaseSensitive,
  History,
  HardDrive,
  Activity,
  ListTodo,
  Monitor,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import type { MaintenanceJobProgress } from '@tracearr/shared';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/formatters';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';

interface JobOption {
  name: string;
  label: string;
  description: string;
  type: 'boolean';
  default: boolean;
}

type JobCategory = 'normalization' | 'backfill' | 'cleanup';

interface JobDefinition {
  type: string;
  category: JobCategory;
  name: string;
  description: string;
  options?: JobOption[];
}

interface JobHistoryItem {
  jobId: string;
  type: string;
  state: string;
  createdAt: number;
  finishedAt?: number;
  result?: {
    success: boolean;
    type: string;
    processed: number;
    updated: number;
    skipped: number;
    errors: number;
    durationMs: number;
    message: string;
  };
}

interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

// Map job types to icons
const JOB_ICONS: Record<string, typeof Database> = {
  normalize_players: Database,
  normalize_countries: Globe,
  normalize_codecs: ArrowUpDown,
  normalize_resolutions: Monitor,
  fix_imported_progress: RefreshCw,
  backfill_user_dates: Calendar,
  backfill_library_snapshots: Library,
  normalize_library_snapshots: Library,
  rebuild_timescale_views: HardDrive,
  full_aggregate_rebuild: History,
  cleanup_old_chunks: Trash2,
  repair_corrupted_chunks: Wrench,
};

const CATEGORY_CONFIG = {
  normalization: { icon: CaseSensitive, labelKey: 'jobs.normalization' as const },
  backfill: { icon: History, labelKey: 'jobs.backfill' as const },
  cleanup: { icon: HardDrive, labelKey: 'jobs.cleanup' as const },
} satisfies Record<JobCategory, { icon: typeof Database; labelKey: string }>;

function RunOutcomeBanner({
  variant,
  icon,
  title,
  description,
  onDismiss,
}: {
  variant?: 'destructive';
  icon: React.ReactNode;
  title: string;
  description: string;
  onDismiss: () => void;
}) {
  const { t } = useTranslation('common');
  return (
    <Alert
      variant={variant}
      className={variant === 'destructive' ? undefined : '[&>svg]:text-success'}
    >
      {icon}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        {t('actions.dismiss')}
      </Button>
    </Alert>
  );
}

export function Jobs() {
  const { t } = useTranslation(['settings', 'notifications', 'pages', 'common']);
  const [jobs, setJobs] = useState<JobDefinition[]>([]);
  const [isLoadingJobs, setIsLoadingJobs] = useState(true);
  const [history, setHistory] = useState<JobHistoryItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [progress, setProgress] = useState<MaintenanceJobProgress | null>(null);
  const [confirmJob, setConfirmJob] = useState<JobDefinition | null>(null);
  const [jobOptions, setJobOptions] = useState<Record<string, boolean>>({});
  const [activeCategory, setActiveCategory] = useState<JobCategory>('normalization');
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const { socket } = useSocket();

  const filteredJobs = useMemo(
    () => jobs.filter((job) => job.category === activeCategory),
    [jobs, activeCategory]
  );

  // Reset options when confirm dialog opens
  const openConfirmDialog = useCallback((job: JobDefinition) => {
    // Initialize options with defaults
    const defaults: Record<string, boolean> = {};
    job.options?.forEach((opt) => {
      if (opt.type === 'boolean') {
        defaults[opt.name] = opt.default;
      }
    });
    setJobOptions(defaults);
    setConfirmJob(job);
  }, []);

  // Fetch available jobs
  useEffect(() => {
    const fetchJobs = async () => {
      try {
        const result = await api.maintenance.getJobs();
        setJobs(result.jobs);
      } catch (err) {
        console.error('Failed to fetch jobs:', err);
        toast.error(t('notifications:toast.error.jobLoadFailed'));
      } finally {
        setIsLoadingJobs(false);
      }
    };

    void fetchJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount; t only labels the error toast and shouldn't force a refetch on locale change
  }, []);

  // Fetch job history
  const fetchHistory = useCallback(async () => {
    try {
      const result = await api.maintenance.getHistory();
      setHistory(result.history);
    } catch (err) {
      console.error('Failed to fetch job history:', err);
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    void fetchHistory();
    // eslint-disable-next-line react/set-state-in-effect -- loads history from the server on mount, not from local input
  }, [fetchHistory]);

  // Fetch queue stats
  const fetchQueueStats = useCallback(async () => {
    try {
      const stats = await api.maintenance.getStats();
      setQueueStats(stats);
    } catch (err) {
      console.error('Failed to fetch queue stats:', err);
    }
  }, []);

  useEffect(() => {
    void fetchQueueStats();
    // Refresh stats every 10 seconds while on the page
    const interval = setInterval(() => void fetchQueueStats(), 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react/set-state-in-effect -- polls the server on an interval, not from local input
  }, [fetchQueueStats]);

  // Check for active job on mount
  useEffect(() => {
    const checkActiveJob = async () => {
      try {
        const result = await api.maintenance.getProgress();
        if (result.progress) {
          const progressData = result.progress as MaintenanceJobProgress;
          setProgress(progressData);
          // Set as running if status is 'running' or 'waiting'
          if (progressData.status === 'running' || progressData.status === 'waiting') {
            setRunningJob(progressData.type);
          }
        }
      } catch (err) {
        console.error('Failed to check active job:', err);
      }
    };

    void checkActiveJob();
  }, []);

  // Listen for progress updates via WebSocket
  useEffect(() => {
    if (!socket) return;

    const handleProgress = (data: MaintenanceJobProgress) => {
      setProgress(data);
      setRunningJob(data.status === 'running' || data.status === 'waiting' ? data.type : null);

      if (data.status === 'complete') {
        toast.success(t('notifications:toast.success.jobCompleted.title'), {
          description: data.message,
        });
        void fetchHistory();
        void fetchQueueStats();
        setRunningJob(null);
      } else if (data.status === 'error') {
        toast.warning(t('notifications:toast.warning.jobFailed.title'), {
          description: data.message,
        });
        void fetchQueueStats();
        setRunningJob(null);
      }
    };

    socket.on('maintenance:progress', handleProgress);
    return () => {
      socket.off('maintenance:progress', handleProgress);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t only labels the toasts and shouldn't re-subscribe the socket listener on locale change
  }, [socket, fetchHistory, fetchQueueStats]);

  const handleStartJob = async (type: string, options?: Record<string, boolean>) => {
    setConfirmJob(null);
    setRunningJob(type);
    setProgress({
      type: type as MaintenanceJobProgress['type'],
      status: 'running',
      totalRecords: 0,
      processedRecords: 0,
      updatedRecords: 0,
      skippedRecords: 0,
      errorRecords: 0,
      message: 'Starting job...',
    });

    try {
      // Only pass options if there are any truthy values
      const hasOptions = options && Object.values(options).some(Boolean);
      await api.maintenance.startJob(type, hasOptions ? options : undefined);
    } catch (err) {
      setRunningJob(null);
      setProgress(null);
      if (err instanceof Error && err.message.includes('already in progress')) {
        toast.error(t('notifications:toast.error.jobAlreadyRunning'));
      } else {
        toast.error(t('notifications:toast.error.jobStartFailed'), {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    }
  };

  const getProgressPercent = () => {
    if (!progress || progress.totalRecords === 0) return 0;
    return Math.round((progress.processedRecords / progress.totalRecords) * 100);
  };

  if (isLoadingJobs) {
    return (
      <SettingsSection title={t('nav.sections.jobs')} description={t('nav.descriptions.jobs')}>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-28 w-full" />
          </CardContent>
        </Card>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={t('nav.sections.jobs')} description={t('nav.descriptions.jobs')}>
      {/* Queue Status Banner */}
      {queueStats &&
        (queueStats.active > 0 || queueStats.waiting > 0 || queueStats.delayed > 0) && (
          <div className="border-primary/20 bg-primary/5 flex items-center gap-4 rounded-lg border px-4 py-3">
            <Activity className="text-primary h-5 w-5" />
            <div className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              {queueStats.active > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="bg-primary absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
                    <span className="bg-primary relative inline-flex h-2 w-2 rounded-full" />
                  </span>
                  <span className="font-medium">{queueStats.active}</span>
                  <span className="text-muted-foreground">{t('jobs.running')}</span>
                </span>
              )}
              {queueStats.waiting > 0 && (
                <span className="flex items-center gap-1.5">
                  <ListTodo className="text-muted-foreground h-3.5 w-3.5" />
                  <span className="font-medium">{queueStats.waiting}</span>
                  <span className="text-muted-foreground">{t('jobs.queued')}</span>
                </span>
              )}
              {queueStats.delayed > 0 && (
                <span className="flex items-center gap-1.5">
                  <Clock className="text-muted-foreground h-3.5 w-3.5" />
                  <span className="font-medium">{queueStats.delayed}</span>
                  <span className="text-muted-foreground">{t('jobs.delayed')}</span>
                </span>
              )}
            </div>
          </div>
        )}

      {/* Available Jobs */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wrench className="h-5 w-5" />
            {t('jobs.title')}
          </CardTitle>
          <CardDescription>{t('jobs.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs
            value={activeCategory}
            onValueChange={(v) => setActiveCategory(v as JobCategory)}
            className="@container/job-tabs w-full"
          >
            <TabsList className="grid w-full grid-cols-3">
              {(Object.keys(CATEGORY_CONFIG) as JobCategory[]).map((category) => {
                const config = CATEGORY_CONFIG[category];
                const CategoryIcon = config.icon;
                const jobCount = jobs.filter((j) => j.category === category).length;
                return (
                  <TabsTrigger key={category} value={category} className="gap-1.5">
                    <CategoryIcon className="h-3.5 w-3.5" />
                    <span className="hidden @md/job-tabs:inline">{t(config.labelKey)}</span>
                    <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                      {jobCount}
                    </Badge>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>

          <ItemGroup className="gap-3">
            {filteredJobs.map((job) => {
              const JobIcon = JOB_ICONS[job.type] || Wrench;
              const isRunning = runningJob === job.type;

              return (
                <Item
                  key={job.type}
                  role="listitem"
                  variant="outline"
                  className={cn(isRunning && 'border-primary/30 bg-primary/5')}
                >
                  <ItemMedia
                    className={cn('size-10 rounded-lg', isRunning ? 'bg-primary/10' : 'bg-muted')}
                  >
                    <JobIcon
                      className={cn(
                        'h-5 w-5',
                        isRunning ? 'text-primary' : 'text-muted-foreground'
                      )}
                    />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{job.name}</ItemTitle>
                    <ItemDescription>{job.description}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      onClick={() => openConfirmDialog(job)}
                      disabled={runningJob !== null}
                      size="sm"
                    >
                      {isRunning ? (
                        progress?.status === 'waiting' ? (
                          <>
                            <Clock className="mr-1.5 h-3.5 w-3.5 animate-pulse" />
                            {t('jobs.waiting')}
                          </>
                        ) : (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            {t('jobs.runningState')}
                          </>
                        )
                      ) : (
                        <>
                          <Play className="mr-1.5 h-3.5 w-3.5" />
                          {t('jobs.runJob')}
                        </>
                      )}
                    </Button>
                  </ItemActions>

                  {isRunning && progress?.status === 'running' && (
                    <div className="w-full space-y-3 border-t pt-4">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{progress.message}</span>
                        <span className="font-medium tabular-nums">{getProgressPercent()}%</span>
                      </div>
                      <Progress value={getProgressPercent()} className="h-1.5" />
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                        <span className="text-muted-foreground">
                          <span className="text-foreground font-medium">
                            {progress.processedRecords.toLocaleString()}
                          </span>{' '}
                          / {progress.totalRecords.toLocaleString()} {t('jobs.processed')}
                        </span>
                        {progress.updatedRecords > 0 && (
                          <span className="text-muted-foreground">
                            <span className="text-success font-medium">
                              {progress.updatedRecords.toLocaleString()}
                            </span>{' '}
                            {t('jobs.updated')}
                          </span>
                        )}
                        {progress.skippedRecords > 0 && (
                          <span className="text-muted-foreground">
                            <span className="font-medium">
                              {progress.skippedRecords.toLocaleString()}
                            </span>{' '}
                            {t('jobs.unchanged')}
                          </span>
                        )}
                        {progress.errorRecords > 0 && (
                          <span className="text-destructive">
                            <span className="font-medium">
                              {progress.errorRecords.toLocaleString()}
                            </span>{' '}
                            {t('jobs.errors')}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {isRunning && progress?.status === 'waiting' && (
                    <div className="w-full border-t pt-4">
                      <div className="flex items-center gap-2 text-sm">
                        <Clock className="text-muted-foreground h-4 w-4 animate-pulse" />
                        <span className="text-muted-foreground">{progress.message}</span>
                      </div>
                    </div>
                  )}
                </Item>
              );
            })}
          </ItemGroup>

          {progress?.status === 'complete' && !runningJob && (
            <RunOutcomeBanner
              icon={<CheckCircle2 />}
              title={t('jobs.lastJobCompleted')}
              description={progress.message}
              onDismiss={() => setProgress(null)}
            />
          )}

          {progress?.status === 'error' && !runningJob && (
            <RunOutcomeBanner
              variant="destructive"
              icon={<XCircle />}
              title={t('jobs.lastJobFailed')}
              description={progress.message}
              onDismiss={() => setProgress(null)}
            />
          )}
        </CardContent>
      </Card>

      {/* Job History */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-5 w-5" />
                {t('jobs.jobHistory')}
              </CardTitle>
              <CardDescription>{t('jobs.jobHistoryDesc')}</CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsLoadingHistory(true);
                void fetchHistory();
              }}
              disabled={isLoadingHistory}
              className="text-muted-foreground hover:text-foreground gap-1.5"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isLoadingHistory && 'animate-spin')} />
              {t('common:actions.refresh')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoadingHistory ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : history.length === 0 ? (
            <EmptyState icon={ArrowUpDown} title={t('common:empty.noJobHistory')} />
          ) : (
            <ItemGroup className="space-y-2">
              {history.map((item) => {
                const isSuccess = item.state === 'completed';

                return (
                  <Item
                    key={item.jobId}
                    role="listitem"
                    variant="outline"
                    size="sm"
                    className={cn(!isSuccess && 'border-destructive/30 bg-destructive/5')}
                  >
                    <ItemMedia variant="icon">
                      {isSuccess ? (
                        <CheckCircle2 className="text-success" />
                      ) : (
                        <XCircle className="text-destructive" />
                      )}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle className="capitalize">
                        {item.type.replace(/_/g, ' ')}
                        <Badge variant={isSuccess ? 'success' : 'destructive'}>
                          {isSuccess ? t('common:states.success') : t('common:states.failed')}
                        </Badge>
                      </ItemTitle>
                      {item.result && (
                        <ItemDescription className="tabular-nums">
                          {item.result.processed.toLocaleString()} {t('jobs.processed')}
                          {item.result.updated > 0 &&
                            ` · ${item.result.updated.toLocaleString()} ${t('jobs.updated')}`}
                          {item.result.errors > 0 && (
                            <span className="text-destructive">
                              {' · '}
                              {item.result.errors.toLocaleString()} {t('jobs.errors')}
                            </span>
                          )}
                        </ItemDescription>
                      )}
                    </ItemContent>
                    <ItemActions className="flex-col items-end gap-0">
                      <span className="text-muted-foreground text-xs">
                        {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                      </span>
                      {item.result && (
                        <span className="text-muted-foreground text-xs tabular-nums">
                          {formatDuration(item.result.durationMs, { style: 'compact' })}
                        </span>
                      )}
                    </ItemActions>
                  </Item>
                );
              })}
            </ItemGroup>
          )}
        </CardContent>
      </Card>

      {/* Confirmation Dialog */}
      <Dialog open={!!confirmJob} onOpenChange={() => setConfirmJob(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('jobs.runConfirm', { name: confirmJob?.name })}</DialogTitle>
            <DialogDescription className="text-sm">{confirmJob?.description}</DialogDescription>
          </DialogHeader>

          {/* Job-specific options */}
          {confirmJob?.options && confirmJob.options.length > 0 && (
            <div className="space-y-3">
              {confirmJob.options.map((opt) => (
                <div key={opt.name} className="flex items-start gap-3 rounded-lg border p-3">
                  <Checkbox
                    id={`option-${opt.name}`}
                    checked={jobOptions[opt.name] ?? opt.default}
                    onCheckedChange={(checked) =>
                      setJobOptions((prev) => ({ ...prev, [opt.name]: checked === true }))
                    }
                  />
                  <div className="flex-1 space-y-1">
                    <Label
                      htmlFor={`option-${opt.name}`}
                      className="cursor-pointer text-sm leading-none font-medium"
                    >
                      {opt.label}
                    </Label>
                    <p className="text-muted-foreground text-xs">{opt.description}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <Alert variant="warning">
            <AlertTriangle />
            <AlertTitle>{t('jobs.mayTakeAWhile')}</AlertTitle>
            <AlertDescription>{t('jobs.mayTakeAWhileDesc')}</AlertDescription>
          </Alert>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmJob(null)}>
              {t('common:actions.cancel')}
            </Button>
            <Button onClick={() => confirmJob && handleStartJob(confirmJob.type, jobOptions)}>
              <Play className="mr-1.5 h-3.5 w-3.5" />
              {t('jobs.startJob')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
