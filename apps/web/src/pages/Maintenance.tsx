import { Database, Loader2, Server, CheckCircle2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMaintenanceMode } from '@/hooks/useMaintenanceMode';
import { LogoIcon } from '@/components/brand/Logo';
import { RESTORE_PHASES } from '@tracearr/shared';

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? 'bg-success' : 'bg-destructive'}`}
    />
  );
}

function RestoreProgress() {
  const { t } = useTranslation('pages');
  const { restore } = useMaintenanceMode();

  if (!restore) return null;

  const currentIdx = (RESTORE_PHASES as readonly string[]).indexOf(restore.phase);
  const isFailed = restore.phase === 'failed';
  const failedIdx = isFailed
    ? (RESTORE_PHASES as readonly string[]).indexOf(restore.failedAtPhase ?? '')
    : -1;
  const effectiveIdx = isFailed ? failedIdx : currentIdx;

  return (
    <div className="w-full max-w-md space-y-4">
      <h1 className="text-foreground text-center text-xl font-semibold">
        {t('maintenance.restoreTitle')}
      </h1>
      <div className="space-y-2">
        {RESTORE_PHASES.map((phase, idx) => {
          const isActive = !isFailed && phase === restore.phase;
          const isDone = idx < effectiveIdx;
          const isFailedPhase = isFailed && idx === failedIdx;
          return (
            <div key={phase} className="flex items-center gap-3 text-sm">
              {isDone ? (
                <CheckCircle2 className="text-success h-4 w-4 shrink-0" />
              ) : isFailedPhase ? (
                <XCircle className="text-destructive h-4 w-4 shrink-0" />
              ) : isActive ? (
                <Loader2 className="text-info h-4 w-4 shrink-0 animate-spin" />
              ) : (
                <span className="bg-muted h-4 w-4 shrink-0 rounded-full" />
              )}
              <span
                className={
                  isFailedPhase
                    ? 'text-destructive font-medium'
                    : isActive
                      ? 'text-foreground font-medium'
                      : isDone
                        ? 'text-muted-foreground'
                        : 'text-muted-foreground/50'
                }
              >
                {t(`maintenance.restorePhase.${phase}`)}
              </span>
            </div>
          );
        })}
      </div>
      {isFailed && (
        <div className="border-destructive/50 bg-destructive/10 rounded-md border p-3">
          <div className="flex items-start gap-2">
            <XCircle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
            <div className="text-destructive text-sm">
              <p className="font-medium">{t('maintenance.restoreFailed')}</p>
              {restore.error && <p className="mt-1 opacity-80">{restore.error}</p>}
              {restore.message && <p className="mt-1 opacity-60">{restore.message}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function Maintenance() {
  const { t } = useTranslation('pages');
  const { db, redis, wasReady, restore, initStep } = useMaintenanceMode();

  return (
    <div className="bg-background flex min-h-screen flex-col items-center justify-center space-y-6 p-4">
      <LogoIcon className="h-16 w-16 opacity-50" />

      {restore ? (
        <RestoreProgress />
      ) : (
        <>
          <h1 className="text-foreground text-xl font-semibold">
            {wasReady ? t('maintenance.interruptionTitle') : t('maintenance.startingTitle')}
          </h1>
          <p className="text-muted-foreground max-w-md text-center">
            {wasReady
              ? t('maintenance.interruptionDescription')
              : t('maintenance.startingDescription')}
          </p>
          <div className="text-muted-foreground flex gap-6 text-sm">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4" />
              <span>TimescaleDB</span>
              <StatusDot ok={db} />
            </div>
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4" />
              <span>Redis</span>
              <StatusDot ok={redis} />
            </div>
          </div>
          {initStep && (
            <div className="max-w-md space-y-2 text-center">
              <p className="text-foreground flex items-center justify-center gap-2 text-sm font-medium">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t(`maintenance.initStep.${initStep}`)}
              </p>
              {(initStep === 'migrations' || initStep === 'timescale') && (
                <p className="border-warning/40 bg-warning/10 text-warning rounded-md border px-3 py-2 text-sm">
                  {t('maintenance.doNotRestart')}
                </p>
              )}
            </div>
          )}
          {!initStep && <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />}
        </>
      )}
    </div>
  );
}
