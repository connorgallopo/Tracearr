import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
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

interface JobDefinition {
  type: string;
  name: string;
  description: string;
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

// Map job types to icons
const JOB_ICONS: Record<string, typeof Database> = {
  normalize_players: Database,
  normalize_countries: Globe,
  fix_imported_progress: RefreshCw,
  rebuild_timescale_views: Database,
  normalize_codecs: ArrowUpDown,
};

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function JobsSettings() {
  const [jobs, setJobs] = useState<JobDefinition[]>([]);
  const [isLoadingJobs, setIsLoadingJobs] = useState(true);
  const [history, setHistory] = useState<JobHistoryItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [progress, setProgress] = useState<MaintenanceJobProgress | null>(null);
  const [confirmJob, setConfirmJob] = useState<JobDefinition | null>(null);
  const { socket } = useSocket();

  // Fetch available jobs
  useEffect(() => {
    const fetchJobs = async () => {
      try {
        const result = await api.maintenance.getJobs();
        setJobs(result.jobs);
      } catch (err) {
        console.error('Failed to fetch jobs:', err);
        toast.error('Failed to load maintenance jobs');
      } finally {
        setIsLoadingJobs(false);
      }
    };

    void fetchJobs();
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
  }, []);

  // Check for active job on mount
  useEffect(() => {
    const checkActiveJob = async () => {
      try {
        const result = await api.maintenance.getProgress();
        if (result.progress) {
          const progressData = result.progress as MaintenanceJobProgress;
          setProgress(progressData);
          // Only set as running if status is actually 'running'
          if (progressData.status === 'running') {
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
      setRunningJob(data.status === 'running' ? data.type : null);

      if (data.status === 'complete') {
        toast.success('Job Completed', {
          description: data.message,
        });
        void fetchHistory();
        setRunningJob(null);
      } else if (data.status === 'error') {
        toast.error('Job Failed', {
          description: data.message,
        });
        setRunningJob(null);
      }
    };

    socket.on('maintenance:progress', handleProgress);
    return () => {
      socket.off('maintenance:progress', handleProgress);
    };
  }, [socket, fetchHistory]);

  const handleStartJob = async (type: string) => {
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
      await api.maintenance.startJob(type);
    } catch (err) {
      setRunningJob(null);
      setProgress(null);
      if (err instanceof Error && err.message.includes('already in progress')) {
        toast.error('Job Already Running', {
          description: 'A maintenance job is already in progress. Please wait for it to complete.',
        });
      } else {
        toast.error('Failed to Start Job', {
          description: err instanceof Error ? err.message : 'Unknown error',
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
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-28 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Available Jobs */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wrench className="h-4 w-4" />
            Maintenance Jobs
          </CardTitle>
          <CardDescription className="text-sm">
            Run maintenance tasks to update historical data or optimize the database
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {jobs.map((job) => {
            const JobIcon = JOB_ICONS[job.type] || Wrench;
            const isRunning = runningJob === job.type;

            return (
              <div
                key={job.type}
                className={cn(
                  'rounded-lg border p-4 transition-colors',
                  isRunning && 'border-primary/30 bg-primary/5'
                )}
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex gap-3">
                    <div
                      className={cn(
                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                        isRunning ? 'bg-primary/10' : 'bg-muted'
                      )}
                    >
                      <JobIcon
                        className={cn(
                          'h-5 w-5',
                          isRunning ? 'text-primary' : 'text-muted-foreground'
                        )}
                      />
                    </div>
                    <div className="space-y-1">
                      <h3 className="leading-none font-medium">{job.name}</h3>
                      <p className="text-muted-foreground text-sm">{job.description}</p>
                    </div>
                  </div>
                  <Button
                    onClick={() => setConfirmJob(job)}
                    disabled={runningJob !== null}
                    size="sm"
                    className="shrink-0 self-start sm:self-center"
                  >
                    {isRunning ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Running
                      </>
                    ) : (
                      <>
                        <Play className="mr-1.5 h-3.5 w-3.5" />
                        Run Job
                      </>
                    )}
                  </Button>
                </div>

                {/* Inline Progress for Running Job */}
                {isRunning && progress?.status === 'running' && (
                  <div className="mt-4 space-y-3 border-t pt-4">
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
                        / {progress.totalRecords.toLocaleString()} processed
                      </span>
                      {progress.updatedRecords > 0 && (
                        <span className="text-muted-foreground">
                          <span className="font-medium text-green-600">
                            {progress.updatedRecords.toLocaleString()}
                          </span>{' '}
                          updated
                        </span>
                      )}
                      {progress.skippedRecords > 0 && (
                        <span className="text-muted-foreground">
                          <span className="font-medium">
                            {progress.skippedRecords.toLocaleString()}
                          </span>{' '}
                          unchanged
                        </span>
                      )}
                      {progress.errorRecords > 0 && (
                        <span className="text-destructive">
                          <span className="font-medium">
                            {progress.errorRecords.toLocaleString()}
                          </span>{' '}
                          errors
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Completed Status Toast Area */}
          {progress?.status === 'complete' && !runningJob && (
            <div className="flex items-start gap-3 rounded-lg border border-green-500/20 bg-green-500/5 p-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-green-600">
                  Last job completed successfully
                </p>
                <p className="text-muted-foreground truncate text-xs">{progress.message}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2"
                onClick={() => setProgress(null)}
              >
                Dismiss
              </Button>
            </div>
          )}

          {progress?.status === 'error' && !runningJob && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-3">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-red-600">Last job failed</p>
                <p className="text-muted-foreground truncate text-xs">{progress.message}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2"
                onClick={() => setProgress(null)}
              >
                Dismiss
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Job History */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="h-4 w-4" />
                Job History
              </CardTitle>
              <CardDescription className="text-sm">
                Recent maintenance job executions
              </CardDescription>
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
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoadingHistory ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : history.length === 0 ? (
            <div className="flex h-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed">
              <ArrowUpDown className="text-muted-foreground h-4 w-4" />
              <p className="text-muted-foreground text-xs">No job history yet</p>
            </div>
          ) : (
            <div className="space-y-2">
              {history.map((item) => {
                const _JobIcon = JOB_ICONS[item.type] || Wrench;
                const isSuccess = item.state === 'completed';

                return (
                  <div
                    key={item.jobId}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border p-3',
                      !isSuccess && 'border-red-500/20 bg-red-500/5'
                    )}
                  >
                    <div
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                        isSuccess ? 'bg-green-500/10' : 'bg-red-500/10'
                      )}
                    >
                      {isSuccess ? (
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-600" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium capitalize">
                          {item.type.replace(/_/g, ' ')}
                        </span>
                        <Badge
                          variant={isSuccess ? 'secondary' : 'destructive'}
                          className="text-[10px]"
                        >
                          {isSuccess ? 'Completed' : 'Failed'}
                        </Badge>
                      </div>
                      {item.result && (
                        <p className="text-muted-foreground mt-0.5 truncate text-xs">
                          {item.result.processed.toLocaleString()} processed
                          {item.result.updated > 0 &&
                            ` · ${item.result.updated.toLocaleString()} updated`}
                          {item.result.errors > 0 && (
                            <span className="text-destructive">
                              {' '}
                              · {item.result.errors.toLocaleString()} errors
                            </span>
                          )}
                        </p>
                      )}
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="text-muted-foreground text-xs">
                        {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                      </p>
                      {item.result && (
                        <p className="text-muted-foreground text-xs tabular-nums">
                          {formatDuration(item.result.durationMs)}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirmation Dialog */}
      <Dialog open={!!confirmJob} onOpenChange={() => setConfirmJob(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Run {confirmJob?.name}?</DialogTitle>
            <DialogDescription className="text-sm">{confirmJob?.description}</DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="text-sm">
              <p className="font-medium text-amber-600">This may take a while</p>
              <p className="text-muted-foreground mt-1 text-xs">
                The job will process all historical sessions. Progress is shown in real-time and you
                can safely navigate away.
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setConfirmJob(null)}>
              Cancel
            </Button>
            <Button onClick={() => confirmJob && handleStartJob(confirmJob.type)}>
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Start Job
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
