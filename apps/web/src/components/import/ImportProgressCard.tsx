import { useTranslation } from 'react-i18next';
import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { Progress } from '../ui/progress';
import { cn } from '@/lib/utils';
import type { HeavyOpsWaitingFor } from '@tracearr/shared';

export type ImportStatus =
  | 'idle'
  | 'waiting'
  | 'detecting'
  | 'fetching'
  | 'enriching'
  | 'processing'
  | 'retrying'
  | 'complete'
  | 'error';

export interface ImportProgressData {
  status: ImportStatus;
  message?: string;
  totalRecords: number;
  processedRecords: number;
  importedRecords: number;
  skippedRecords: number;
  errorRecords: number;
  // Tautulli-specific
  currentPage?: number;
  totalPages?: number;
  // Jellystat-specific
  enrichedRecords?: number;
  filteredRecords?: number;
  // Heavy ops coordination
  waitingFor?: HeavyOpsWaitingFor;
}

interface ImportProgressCardProps {
  progress: ImportProgressData | null;
  showPageProgress?: boolean;
  /** Applied while there is an import to show */
  className?: string;
}

const isActiveStatus = (status: ImportStatus) =>
  status === 'detecting' ||
  status === 'fetching' ||
  status === 'enriching' ||
  status === 'processing';

export function ImportProgressCard({
  progress,
  showPageProgress = false,
  className,
}: ImportProgressCardProps) {
  const { t } = useTranslation('settings');
  // A run changes its message and counts every page, so the region holds one fixed line for it
  const announced =
    progress && isActiveStatus(progress.status) ? t('import.importing') : (progress?.message ?? '');

  return (
    <div className={cn(progress && ['space-y-3 rounded-lg border p-4', className])}>
      {/* Rendered with no import too, so the region is in place before the first state */}
      <p role="status" className="sr-only">
        {announced}
      </p>
      {progress && <CardContent progress={progress} showPageProgress={showPageProgress} />}
    </div>
  );
}

function CardContent({
  progress,
  showPageProgress,
}: {
  progress: ImportProgressData;
  showPageProgress: boolean;
}) {
  // A retry waits out its backoff, so it reads as waiting
  const isWaiting = progress.status === 'waiting' || progress.status === 'retrying';
  const isActive = isActiveStatus(progress.status);
  const isComplete = progress.status === 'complete';
  const isError = progress.status === 'error';

  const percentComplete =
    progress.totalRecords > 0
      ? Math.min(100, Math.round((progress.processedRecords / progress.totalRecords) * 100))
      : 0;

  const statusLabel = isWaiting
    ? 'Waiting...'
    : isComplete
      ? 'Import Complete'
      : isError
        ? 'Import Failed'
        : 'Importing...';

  return (
    <>
      {/* Header with status */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{statusLabel}</span>
        {isComplete && <CheckCircle2 className="text-success h-5 w-5" />}
        {isError && <XCircle className="text-destructive h-5 w-5" />}
        {isWaiting && <Clock className="text-muted-foreground h-5 w-5 animate-pulse" />}
        {isActive && <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />}
      </div>

      {/* Message */}
      {progress.message && (
        <p className={cn('text-sm', isError ? 'text-destructive' : 'text-muted-foreground')}>
          {progress.message}
        </p>
      )}

      {/* Progress bar and stats - only when we have records */}
      {progress.totalRecords > 0 && (
        <>
          <Progress value={isComplete ? 100 : percentComplete} className="h-2" />

          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">Processed:</span>{' '}
              <span className="font-medium">
                {progress.processedRecords.toLocaleString()} /{' '}
                {progress.totalRecords.toLocaleString()}
              </span>
            </div>

            {showPageProgress &&
              progress.currentPage !== undefined &&
              progress.totalPages !== undefined && (
                <div>
                  <span className="text-muted-foreground">Page:</span>{' '}
                  <span className="font-medium">
                    {progress.currentPage} / {progress.totalPages}
                  </span>
                </div>
              )}

            <div>
              <span className="text-muted-foreground">Imported:</span>{' '}
              <span className="text-success font-medium">
                {progress.importedRecords.toLocaleString()}
              </span>
            </div>

            <div>
              <span className="text-muted-foreground">Skipped:</span>{' '}
              <span className="text-warning font-medium">
                {progress.skippedRecords.toLocaleString()}
              </span>
            </div>

            {progress.enrichedRecords !== undefined && progress.enrichedRecords > 0 && (
              <div>
                <span className="text-muted-foreground">Enriched:</span>{' '}
                <span className="text-info font-medium">
                  {progress.enrichedRecords.toLocaleString()}
                </span>
              </div>
            )}

            {progress.filteredRecords !== undefined && progress.filteredRecords > 0 && (
              <div>
                <span className="text-muted-foreground">Filtered:</span>{' '}
                <span className="text-warning font-medium">
                  {progress.filteredRecords.toLocaleString()}
                </span>
              </div>
            )}

            {progress.errorRecords > 0 && (
              <div>
                <span className="text-muted-foreground">Errors:</span>{' '}
                <span className="text-destructive font-medium">
                  {progress.errorRecords.toLocaleString()}
                </span>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
