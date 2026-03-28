import { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Archive,
  ArrowLeft,
  Download,
  Trash2,
  DatabaseBackup,
  Upload,
  Loader2,
  AlertTriangle,
  Clock,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { RESTORE_PHASES, type BackupListItem } from '@tracearr/shared';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/formatters';
import { useMaintenanceMode, MAINTENANCE_EVENT } from '@/hooks/useMaintenanceMode';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

// ============================================================================
// Backup Card — Create, Upload, History
// ============================================================================

function BackupCard({ onRestore }: { onRestore: (backup: BackupListItem) => void }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const { data: info } = useQuery({
    queryKey: ['backup-info'],
    queryFn: api.backup.getInfo,
  });

  const { data: backups, isLoading } = useQuery({
    queryKey: ['backups'],
    queryFn: api.backup.list,
  });

  const databaseSize = info?.databaseSize;
  const freeSpace = info?.freeSpace;
  const lowDiskSpace = databaseSize != null && freeSpace != null && freeSpace < databaseSize * 2;

  const createMutation = useMutation({
    mutationFn: () => api.backup.create(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['backups'] });
      toast.success(t('backup.toast.backupCreated'));
    },
    onError: (err) => {
      toast.error(t('backup.toast.backupCreateFailed'), { description: err.message });
    },
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => api.backup.upload(file),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['backups'] });
      toast.success(t('backup.toast.backupUploaded'));
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    onError: (err) => {
      toast.error(t('backup.toast.backupUploadFailed'), { description: err.message });
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (filename: string) => api.backup.deleteBackup(filename),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['backups'] });
      toast.success(t('backup.toast.backupDeleted'));
      setDeleteTarget(null);
    },
    onError: (err) => {
      toast.error(t('backup.toast.backupDeleteFailed'), { description: err.message });
      setDeleteTarget(null);
    },
  });

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        uploadMutation.mutate(file);
      }
    },
    [uploadMutation]
  );

  const typeLabel = (type: string) => {
    switch (type) {
      case 'manual':
        return t('backup.typeManual');
      case 'scheduled':
        return t('backup.typeScheduled');
      case 'uploaded':
        return t('backup.typeUploaded');
      default:
        return type;
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Archive className="h-5 w-5" />
            {t('backup.title')}
            <span className="rounded bg-amber-500/10 px-2 py-1 text-sm leading-normal font-semibold tracking-wide text-amber-500">
              BETA
            </span>
          </CardTitle>
          <CardDescription>
            {t('backup.description', { backupDir: info?.backupDir ?? '/data/backup' })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Create & Upload */}
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || uploadMutation.isPending}
            >
              {createMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Archive className="mr-2 h-4 w-4" />
              )}
              {createMutation.isPending ? t('backup.creating') : t('backup.createBackup')}
            </Button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              onChange={handleFileUpload}
              className="hidden"
            />
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={createMutation.isPending || uploadMutation.isPending}
            >
              {uploadMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              {uploadMutation.isPending ? t('backup.uploading') : t('backup.uploadBackup')}
            </Button>
          </div>

          {(databaseSize != null || freeSpace != null) && (
            <div className="space-y-2">
              <div className="text-muted-foreground space-y-0.5 text-sm">
                {databaseSize != null && (
                  <p>{t('backup.databaseSize', { size: formatBytes(databaseSize, 2) })}</p>
                )}
                {freeSpace != null && (
                  <p>{t('backup.freeSpace', { size: formatBytes(freeSpace, 2) })}</p>
                )}
              </div>
              {lowDiskSpace && (
                <div className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-sm text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {t('backup.lowDiskSpace')}
                </div>
              )}
            </div>
          )}

          {/* Backup History */}
          <div>
            <h3 className="mb-3 text-sm font-medium">{t('backup.backupHistory')}</h3>
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : !backups || backups.length === 0 ? (
              <p className="text-muted-foreground py-4 text-center text-sm">
                {t('backup.noBackups')}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pr-4 pb-2 font-medium">{t('backup.filename')}</th>
                      <th className="pr-4 pb-2 font-medium">{t('backup.size')}</th>
                      <th className="pr-4 pb-2 font-medium">{t('backup.date')}</th>
                      <th className="pr-4 pb-2 font-medium">{t('backup.type')}</th>
                      <th className="pr-4 pb-2 font-medium">{t('backup.version')}</th>
                      <th className="pb-2 text-right font-medium">{t('backup.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backups.map((backup) => (
                      <tr key={backup.filename} className="border-b last:border-0">
                        <td className="py-2 pr-4 font-mono text-xs">{backup.filename}</td>
                        <td className="py-2 pr-4">{formatBytes(backup.size, 2)}</td>
                        <td className="py-2 pr-4">{formatDate(backup.createdAt)}</td>
                        <td className="py-2 pr-4">{typeLabel(backup.type)}</td>
                        <td className="py-2 pr-4">{backup.metadata.app.version}</td>
                        <td className="py-2 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={() => onRestore(backup)}>
                              <DatabaseBackup className="mr-1 h-3.5 w-3.5" />
                              {t('backup.restoreAction')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void api.backup.download(backup.filename)}
                            >
                              <Download className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDeleteTarget(backup.filename)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('backup.deleteConfirmTitle')}
        description={t('backup.deleteConfirmDescription')}
        confirmLabel={t('backup.delete')}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
}

// ============================================================================
// Restore Card — Shown when user selects a backup to restore
// ============================================================================

function RestoreCard({ backup, onClose }: { backup: BackupListItem; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const [confirmed, setConfirmed] = useState(false);
  const { restore: restoreProgress } = useMaintenanceMode();

  const { data: info } = useQuery({
    queryKey: ['backup-info'],
    queryFn: api.backup.getInfo,
  });
  const canRestore = info?.canRestore ?? true;

  // Client-side version compatibility checks
  const backupPgMajor = parseInt(
    backup.metadata.database.pgVersion.match(/^(\d+)/)?.[1] ?? '0',
    10
  );
  const serverPgMajor = parseInt(info?.pgVersion?.match(/^(\d+)/)?.[1] ?? '0', 10);
  const pgVersionMismatch = serverPgMajor > 0 && backupPgMajor > serverPgMajor;

  const backupTsVersion = backup.metadata.database.timescaleVersion;
  const serverTsVersion = info?.timescaleVersion ?? '';
  const tsVersionMismatch =
    serverTsVersion !== '' &&
    backupTsVersion.localeCompare(serverTsVersion, undefined, { numeric: true }) > 0;

  const canStartRestore = canRestore && !pgVersionMismatch && !tsVersionMismatch;

  const restoreMutation = useMutation({
    mutationFn: () => api.backup.restore(backup.filename),
    onSuccess: () => {
      toast.success(t('backup.toast.restoreStarted'));
      globalThis.dispatchEvent(new Event(MAINTENANCE_EVENT));
    },
    onError: (err) => {
      toast.error(t('backup.toast.restoreStartFailed'), { description: err.message });
    },
  });

  const isRestoring = restoreMutation.isPending || restoreMutation.isSuccess;
  const currentPhaseIdx = restoreProgress
    ? (RESTORE_PHASES as readonly string[]).indexOf(restoreProgress.phase)
    : -1;
  const isFailed = restoreProgress?.phase === 'failed';
  const isComplete = restoreProgress?.phase === 'complete';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DatabaseBackup className="h-5 w-5" />
          {t('backup.restore.title')}
          <span className="rounded bg-amber-500/10 px-2 py-1 text-sm leading-normal font-semibold tracking-wide text-amber-500">
            BETA
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Backup details */}
        <dl className="grid max-w-lg grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t('backup.restore.selectedBackup')}</dt>
          <dd className="font-mono">{backup.filename}</dd>
          <dt className="text-muted-foreground">{t('backup.date')}</dt>
          <dd>{formatDate(backup.createdAt)}</dd>
          <dt className="text-muted-foreground">{t('backup.version')}</dt>
          <dd>{backup.metadata.app.version}</dd>
          <dt className="text-muted-foreground">{t('backup.restore.databaseSize')}</dt>
          <dd>{formatBytes(backup.metadata.database.databaseSize, 2)}</dd>
          <dt className="text-muted-foreground">{t('backup.restore.sessions')}</dt>
          <dd>{backup.metadata.counts.sessions.toLocaleString()}</dd>
          <dt className="text-muted-foreground">{t('backup.restore.users')}</dt>
          <dd>{backup.metadata.counts.users.toLocaleString()}</dd>
          <dt className="text-muted-foreground">{t('backup.restore.servers')}</dt>
          <dd>{backup.metadata.counts.servers.toLocaleString()}</dd>
          <dt className="text-muted-foreground">{t('backup.restore.rules')}</dt>
          <dd>{backup.metadata.counts.rules.toLocaleString()}</dd>
          <dt className="text-muted-foreground">{t('backup.restore.libraryItems')}</dt>
          <dd>{backup.metadata.counts.libraryItems.toLocaleString()}</dd>
          <dt className="text-muted-foreground">{t('backup.restore.tables')}</dt>
          <dd>{backup.metadata.database.tableCount}</dd>
          <dt className="text-muted-foreground">PostgreSQL</dt>
          <dd>{backup.metadata.database.pgVersion}</dd>
          <dt className="text-muted-foreground">TimescaleDB</dt>
          <dd>{backup.metadata.database.timescaleVersion}</dd>
        </dl>

        {/* Cannot restore warnings */}
        {!canStartRestore && !isRestoring && (
          <div className="border-destructive/50 bg-destructive/10 rounded-md border p-3">
            <div className="flex items-start gap-2">
              <XCircle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
              <div className="text-destructive space-y-1 text-sm">
                {!canRestore && <p>{t('backup.restore.cannotRestore')}</p>}
                {pgVersionMismatch && (
                  <p>
                    {t('backup.restore.pgVersionMismatch', {
                      backupVersion: backupPgMajor,
                      serverVersion: serverPgMajor,
                    })}
                  </p>
                )}
                {tsVersionMismatch && (
                  <p>
                    {t('backup.restore.tsVersionMismatch', {
                      backupVersion: backupTsVersion,
                      serverVersion: serverTsVersion,
                    })}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Warning */}
        {!isRestoring && canStartRestore && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <p className="text-sm text-amber-700 dark:text-amber-400">
                {t('backup.restore.warning')}
              </p>
            </div>
          </div>
        )}

        {/* Progress display during restore */}
        {isRestoring && restoreProgress && (
          <div className="space-y-2">
            {RESTORE_PHASES.map((phase, idx) => {
              const isActive = phase === restoreProgress.phase;
              const isDone = idx < currentPhaseIdx;
              return (
                <div key={phase} className="flex items-center gap-3 text-sm">
                  {isDone ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                  ) : isActive ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />
                  ) : (
                    <span className="bg-muted h-4 w-4 shrink-0 rounded-full" />
                  )}
                  <span
                    className={
                      isActive
                        ? 'text-foreground font-medium'
                        : isDone
                          ? 'text-muted-foreground'
                          : 'text-muted-foreground/50'
                    }
                  >
                    {t(`backup.restore.phase.${phase}`, { defaultValue: phase })}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Failed state */}
        {isFailed && restoreProgress?.error && (
          <div className="border-destructive/50 bg-destructive/10 rounded-md border p-3">
            <div className="flex items-start gap-2">
              <XCircle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
              <div className="text-destructive text-sm">
                <p className="font-medium">{t('backup.restore.failed')}</p>
                <p className="mt-1 opacity-80">{restoreProgress.error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Complete state */}
        {isComplete && (
          <div className="rounded-md border border-green-500/50 bg-green-500/10 p-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
              <p className="text-sm text-green-700 dark:text-green-400">
                {t('backup.restore.complete')}
              </p>
            </div>
          </div>
        )}

        {/* Actions */}
        {!isRestoring && (
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={confirmed}
                onCheckedChange={(checked) => setConfirmed(checked === true)}
              />
              {t('backup.restore.confirmLabel')}
            </label>
            <div className="flex gap-2">
              <Button
                onClick={() => restoreMutation.mutate()}
                disabled={!confirmed || !canStartRestore || restoreMutation.isPending}
                variant="destructive"
              >
                {restoreMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('backup.restore.confirm')}
              </Button>
              <Button variant="outline" onClick={onClose}>
                {t('backup.restore.cancel')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Schedule Card — Automatic backup scheduling
// ============================================================================

function ScheduleCard() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();

  const { data: schedule, isLoading } = useQuery({
    queryKey: ['backup-schedule'],
    queryFn: api.backup.getSchedule,
  });

  const updateMutation = useMutation({
    mutationFn: api.backup.updateSchedule,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['backup-schedule'] });
      toast.success(t('backup.toast.scheduleSaved'));
    },
    onError: (err) => {
      toast.error(t('backup.toast.scheduleError'), { description: err.message });
    },
  });

  const retentionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (isLoading || !schedule) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  const handleChange = (field: string, value: string | number) => {
    const updated = { ...schedule, [field]: value };
    updateMutation.mutate(updated);
  };

  const days = [
    t('backup.daySun'),
    t('backup.dayMon'),
    t('backup.dayTue'),
    t('backup.dayWed'),
    t('backup.dayThu'),
    t('backup.dayFri'),
    t('backup.daySat'),
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5" />
          {t('backup.schedule')}
          <span className="rounded bg-amber-500/10 px-2 py-1 text-sm leading-normal font-semibold tracking-wide text-amber-500">
            BETA
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Schedule type */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t('backup.scheduleType')}</label>
          <Select value={schedule.type} onValueChange={(v) => handleChange('type', v)}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="disabled">{t('backup.scheduleDisabled')}</SelectItem>
              <SelectItem value="daily">{t('backup.scheduleDaily')}</SelectItem>
              <SelectItem value="weekly">{t('backup.scheduleWeekly')}</SelectItem>
              <SelectItem value="monthly">{t('backup.scheduleMonthly')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {schedule.type !== 'disabled' && (
          <>
            {/* Time (hour + minute selects) */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                {t('backup.scheduleTime', { timezone: schedule.timezone ?? 'UTC' })}
              </label>
              <div className="flex items-center gap-2">
                <Select
                  value={schedule.time.split(':')[0]}
                  onValueChange={(h) => handleChange('time', `${h}:${schedule.time.split(':')[1]}`)}
                >
                  <SelectTrigger className="w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')).map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground">:</span>
                <Select
                  value={schedule.time.split(':')[1]}
                  onValueChange={(m) => handleChange('time', `${schedule.time.split(':')[0]}:${m}`)}
                >
                  <SelectTrigger className="w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['00', '15', '30', '45'].map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Day of week (weekly) */}
            {schedule.type === 'weekly' && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('backup.scheduleDayOfWeek')}</label>
                <Select
                  value={String(schedule.dayOfWeek)}
                  onValueChange={(v) => handleChange('dayOfWeek', parseInt(v, 10))}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {days.map((day, i) => (
                      <SelectItem key={i} value={String(i)}>
                        {day}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Day of month (monthly) */}
            {schedule.type === 'monthly' && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('backup.scheduleDayOfMonth')}</label>
                <Select
                  value={String(schedule.dayOfMonth)}
                  onValueChange={(v) => handleChange('dayOfMonth', parseInt(v, 10))}
                >
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  {t('backup.scheduleDayOfMonthHint')}
                </p>
              </div>
            )}

            {/* Retention */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('backup.retentionCount')}</label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={30}
                  defaultValue={schedule.retentionCount}
                  onChange={(e) => {
                    if (retentionTimerRef.current) clearTimeout(retentionTimerRef.current);
                    const val = parseInt(e.target.value, 10) || 7;
                    retentionTimerRef.current = setTimeout(
                      () => handleChange('retentionCount', val),
                      1000
                    );
                  }}
                  className="w-20"
                />
                <span className="text-muted-foreground text-sm">{t('backup.retentionSuffix')}</span>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Main Export
// ============================================================================

export function BackupSettings() {
  const { t } = useTranslation('settings');
  const [restoreTarget, setRestoreTarget] = useState<BackupListItem | null>(null);

  if (restoreTarget) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" size="sm" onClick={() => setRestoreTarget(null)}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          {t('backup.backToBackups')}
        </Button>
        <RestoreCard backup={restoreTarget} onClose={() => setRestoreTarget(null)} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <BackupCard onRestore={setRestoreTarget} />
      <ScheduleCard />
    </div>
  );
}
