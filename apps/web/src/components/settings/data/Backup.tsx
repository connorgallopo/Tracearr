import { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Archive,
  ArrowLeft,
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
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { AutosaveNumberField } from '@/components/ui/autosave-field';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/formatters';
import { useMaintenanceMode, MAINTENANCE_EVENT } from '@/hooks/useMaintenanceMode';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { BetaBadge } from '@/components/settings/shared/BetaBadge';
import { dateLabel } from '@/components/settings/shared/dateLabel';
import { BackupHistory } from './BackupHistory';

const RETENTION_DEBOUNCE_MS = 1000;

// ============================================================================
// Backup Card — Create, Upload, History
// ============================================================================

function BackupCard({ onRestore }: { onRestore: (backup: BackupListItem) => void }) {
  const { t } = useTranslation(['settings', 'common']);
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

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Archive className="h-5 w-5" />
            {t('backup.title')}
            <BetaBadge />
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
              {createMutation.isPending ? <Loader2 className="animate-spin" /> : <Archive />}
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
                <Loader2 className="animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              {uploadMutation.isPending ? t('backup.uploading') : t('backup.uploadBackup')}
            </Button>
          </div>

          {(databaseSize != null || freeSpace != null) && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
                {databaseSize != null && (
                  <span>{t('backup.databaseSize', { size: formatBytes(databaseSize, 2) })}</span>
                )}
                {freeSpace != null && (
                  <span>{t('backup.freeSpace', { size: formatBytes(freeSpace, 2) })}</span>
                )}
              </div>
              {lowDiskSpace && (
                <Alert variant="warning">
                  <AlertTriangle />
                  <AlertDescription>{t('backup.lowDiskSpace')}</AlertDescription>
                </Alert>
              )}
            </div>
          )}

          {/* Backup History */}
          <div>
            <h3 className="mb-3 text-sm font-medium">{t('backup.backupHistory')}</h3>
            <BackupHistory
              backups={backups ?? []}
              isLoading={isLoading}
              onRestore={onRestore}
              onDelete={setDeleteTarget}
            />
          </div>
        </CardContent>
      </Card>

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('backup.deleteConfirmTitle')}
        description={t('backup.deleteConfirmDescription')}
        confirmLabel={t('common:actions.delete')}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
}

// ============================================================================
// Restore Card — Shown when user selects a backup to restore
// ============================================================================

export function RestoreCard({ backup, onClose }: { backup: BackupListItem; onClose: () => void }) {
  const { t } = useTranslation(['settings', 'common']);
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
          <BetaBadge />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Backup details */}
        <dl className="grid max-w-lg grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t('backup.restore.selectedBackup')}</dt>
          <dd className="font-mono">{backup.filename}</dd>
          <dt className="text-muted-foreground">{t('backup.date')}</dt>
          <dd>{dateLabel(backup.createdAt)}</dd>
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
          <dt className="text-muted-foreground">{t('backup.restore.automations')}</dt>
          <dd>
            {(
              backup.metadata.counts.automations ??
              backup.metadata.counts.rules ??
              0
            ).toLocaleString()}
          </dd>
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
          <Alert variant="destructive">
            <XCircle />
            <AlertDescription>
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
            </AlertDescription>
          </Alert>
        )}

        {/* Warning */}
        {!isRestoring && canStartRestore && (
          <Alert variant="warning">
            <AlertTriangle />
            <AlertDescription>{t('backup.restore.warning')}</AlertDescription>
          </Alert>
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
                    <CheckCircle2 className="text-success h-4 w-4 shrink-0" />
                  ) : isActive ? (
                    <Loader2 className="text-primary h-4 w-4 shrink-0 animate-spin" />
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
          <Alert variant="destructive">
            <XCircle />
            <AlertTitle>{t('backup.restore.failed')}</AlertTitle>
            <AlertDescription>{restoreProgress.error}</AlertDescription>
          </Alert>
        )}

        {/* Complete state */}
        {isComplete && (
          <Alert className="[&>svg]:text-success">
            <CheckCircle2 />
            <AlertDescription>{t('backup.restore.complete')}</AlertDescription>
          </Alert>
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
                {restoreMutation.isPending && <Loader2 className="animate-spin" />}
                {t('backup.restore.confirm')}
              </Button>
              <Button variant="outline" onClick={onClose}>
                {t('common:actions.cancel')}
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

/** Debounces retention edits locally; NumericInput fires onChange per keystroke, so saving on every one would fire mid-typing. */
export function RetentionField({
  retentionCount,
  onSettle,
  isSaving,
}: {
  retentionCount: number;
  onSettle: (value: number) => void;
  isSaving: boolean;
}) {
  const { t } = useTranslation('settings');
  const [value, setValue] = useState(retentionCount);
  const debounced = useDebouncedValue(value, RETENTION_DEBOUNCE_MS, onSettle);

  return (
    <AutosaveNumberField
      id="backup-retention"
      label={t('backup.retentionCount')}
      value={value}
      onChange={setValue}
      min={1}
      max={30}
      suffix={t('backup.retentionSuffix')}
      status={isSaving || value !== debounced ? 'saving' : 'idle'}
    />
  );
}

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
          <BetaBadge />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Schedule type */}
        <Field>
          <FieldLabel htmlFor="backup-schedule-type">{t('backup.scheduleType')}</FieldLabel>
          <Select value={schedule.type} onValueChange={(v) => handleChange('type', v)}>
            <SelectTrigger id="backup-schedule-type" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="disabled">{t('backup.scheduleDisabled')}</SelectItem>
              <SelectItem value="daily">{t('backup.scheduleDaily')}</SelectItem>
              <SelectItem value="weekly">{t('backup.scheduleWeekly')}</SelectItem>
              <SelectItem value="monthly">{t('backup.scheduleMonthly')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {schedule.type !== 'disabled' && (
          <>
            {/* Time (hour + minute selects) */}
            <Field>
              <FieldLabel>
                {t('backup.scheduleTime', { timezone: schedule.timezone ?? 'UTC' })}
              </FieldLabel>
              <div className="flex items-center gap-2">
                <Select
                  value={schedule.time.split(':')[0]}
                  onValueChange={(h) => handleChange('time', `${h}:${schedule.time.split(':')[1]}`)}
                >
                  <SelectTrigger className="w-20" aria-label={t('backup.scheduleHour')}>
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
                  <SelectTrigger className="w-20" aria-label={t('backup.scheduleMinute')}>
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
            </Field>

            {/* Day of week (weekly) */}
            {schedule.type === 'weekly' && (
              <Field>
                <FieldLabel htmlFor="backup-schedule-day-of-week">
                  {t('backup.scheduleDayOfWeek')}
                </FieldLabel>
                <Select
                  value={String(schedule.dayOfWeek)}
                  onValueChange={(v) => handleChange('dayOfWeek', parseInt(v, 10))}
                >
                  <SelectTrigger id="backup-schedule-day-of-week" className="w-48">
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
              </Field>
            )}

            {/* Day of month (monthly) */}
            {schedule.type === 'monthly' && (
              <Field>
                <FieldLabel htmlFor="backup-schedule-day-of-month">
                  {t('backup.scheduleDayOfMonth')}
                </FieldLabel>
                <Select
                  value={String(schedule.dayOfMonth)}
                  onValueChange={(v) => handleChange('dayOfMonth', parseInt(v, 10))}
                >
                  <SelectTrigger id="backup-schedule-day-of-month" className="w-24">
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
                <FieldDescription>{t('backup.scheduleDayOfMonthHint')}</FieldDescription>
              </Field>
            )}

            {/* Retention */}
            <RetentionField
              retentionCount={schedule.retentionCount}
              onSettle={(value) => handleChange('retentionCount', value)}
              isSaving={updateMutation.isPending}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Main Export
// ============================================================================

export function Backup() {
  const { t } = useTranslation('settings');
  const [restoreTarget, setRestoreTarget] = useState<BackupListItem | null>(null);

  return (
    <SettingsSection title={t('nav.sections.backup')} description={t('nav.descriptions.backup')}>
      {restoreTarget ? (
        <div className="space-y-6">
          <Button variant="ghost" size="sm" onClick={() => setRestoreTarget(null)}>
            <ArrowLeft />
            {t('backup.backToBackups')}
          </Button>
          <RestoreCard backup={restoreTarget} onClose={() => setRestoreTarget(null)} />
        </div>
      ) : (
        <div className="space-y-6">
          <BackupCard onRestore={setRestoreTarget} />
          <ScheduleCard />
        </div>
      )}
    </SettingsSection>
  );
}
