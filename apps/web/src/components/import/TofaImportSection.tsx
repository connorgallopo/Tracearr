import { useEffect, useEffectEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, Download, Info, Loader2 } from 'lucide-react';
import {
  WS_EVENTS,
  assertNever,
  type Server,
  type TofaBackfillStatus,
  type TofaImportProgress,
} from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { useTofaImports, waitingForLibrarySyncMessage } from '@/hooks/queries/useImports';
import { useSocket } from '@/hooks/useSocket';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ImportProgressCard, type ImportProgressData } from './ImportProgressCard';

const blankProgress = (
  status: TofaImportProgress['status'],
  message: string
): TofaImportProgress => ({
  status,
  fetchedRecords: 0,
  processedRecords: 0,
  importedRecords: 0,
  skippedRecords: 0,
  duplicateRecords: 0,
  unknownUserRecords: 0,
  activeRecords: 0,
  errorRecords: 0,
  message,
});

const isPending = (backfill: TofaBackfillStatus | null) =>
  backfill?.state === 'waitingForLibrarySync' ||
  backfill?.state === 'queued' ||
  backfill?.state === 'running';

/** The server's latest import as the progress card shows it, or null when it has none. */
function backfillProgress(
  backfill: TofaBackfillStatus | null,
  t: TFunction<['settings', 'common']>
): TofaImportProgress | null {
  switch (backfill?.state) {
    case undefined:
      return null;
    case 'waitingForLibrarySync':
      return blankProgress('waiting', waitingForLibrarySyncMessage(backfill, t));
    case 'queued':
      return blankProgress('waiting', t('import.importQueued'));
    case 'running':
      return backfill.progress ?? blankProgress('processing', t('import.importInProgressGeneric'));
    case 'complete': {
      const { result } = backfill;
      const processed = result.imported + result.skipped + result.errors;
      return {
        ...blankProgress('complete', result.message),
        fetchedRecords: processed,
        processedRecords: processed,
        importedRecords: result.imported,
        skippedRecords: result.skipped,
        duplicateRecords: result.duplicates,
        errorRecords: result.errors,
      };
    }
    case 'failed':
      return blankProgress('error', backfill.message ?? t('import.importFailed'));
    default:
      return assertNever(backfill);
  }
}

export function TofaImportSection({
  servers,
  onStarted,
}: {
  servers: Server[];
  onStarted?: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const { socket } = useSocket();
  const [pickedServerId, setServerId] = useState('');
  const [progress, setProgress] = useState<TofaImportProgress | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const imports = useTofaImports(servers.map((server) => server.id));
  const backfillOf = (id: string) => imports.byServer.get(id)?.data?.backfill ?? null;

  // Until the owner picks one, show the server whose import is under way, else one with a result
  const serverId =
    pickedServerId ||
    servers.find((server) => isPending(backfillOf(server.id)))?.id ||
    servers.find((server) => backfillOf(server.id) !== null)?.id ||
    (servers[0]?.id ?? '');
  const backfill = backfillOf(serverId);
  const shown = progress ?? backfillProgress(backfill, t);
  const importing = isImporting || backfill?.state === 'running';
  // While waiting, queued or done, the card says where the import stands and there is no button
  const offerImport =
    shown?.status !== 'complete' &&
    backfill?.state !== 'waitingForLibrarySync' &&
    backfill?.state !== 'queued';

  const underway = backfill !== null && backfill.state !== 'failed';
  const announce = useEffectEvent(() => onStarted?.());
  useEffect(() => {
    if (underway) announce();
  }, [underway]);

  useEffect(() => {
    if (!socket) return;

    const handleProgress = (next: TofaImportProgress) => {
      setProgress(next);
      if (next.status === 'complete' || next.status === 'error') {
        setIsImporting(false);
      }
    };

    socket.on(WS_EVENTS.IMPORT_TOFA_PROGRESS, handleProgress);
    return () => {
      socket.off(WS_EVENTS.IMPORT_TOFA_PROGRESS, handleProgress);
    };
  }, [socket]);

  const handleStart = async () => {
    onStarted?.();
    setIsImporting(true);
    setProgress(blankProgress('fetching', t('import.startingImport')));
    try {
      await api.import.tofa.start(serverId);
    } catch (err) {
      setIsImporting(false);
      setProgress(
        blankProgress('error', err instanceof Error ? err.message : t('import.importFailed'))
      );
    }
  };

  const progressData: ImportProgressData | null = shown
    ? {
        status: shown.status,
        message: shown.message,
        totalRecords: shown.fetchedRecords,
        processedRecords: shown.processedRecords,
        importedRecords: shown.importedRecords,
        skippedRecords: shown.skippedRecords,
        errorRecords: shown.errorRecords,
        waitingFor: shown.waitingFor,
      }
    : null;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h4 className="text-sm font-semibold">{t('import.tofaHistory')}</h4>
        <p className="text-muted-foreground text-sm">{t('import.tofaHistoryDesc')}</p>
      </div>

      {servers.length > 1 && (
        <Field>
          <FieldLabel htmlFor="tofaServer">{t('import.targetServer')}</FieldLabel>
          <Select
            value={serverId}
            onValueChange={setServerId}
            disabled={isImporting || isPending(backfill)}
          >
            <SelectTrigger id="tofaServer">
              <SelectValue placeholder={t('import.selectTofaServer')} />
            </SelectTrigger>
            <SelectContent>
              {servers.map((server) => (
                <SelectItem key={server.id} value={server.id}>
                  <div className="flex items-center gap-2">
                    <MediaServerIcon type={server.type} className="h-4 w-4" />
                    {server.name}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <div className={cn('space-y-4', servers.length > 1 && 'border-t pt-6')}>
        {offerImport && (
          <Button onClick={() => void handleStart()} disabled={!serverId || importing} size="lg">
            {importing ? (
              <>
                <Loader2 className="animate-spin" />
                {t('import.importing')}
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                {t('import.importTofaHistory')}
              </>
            )}
          </Button>
        )}

        {progressData && (
          <div className="space-y-2">
            <ImportProgressCard progress={progressData} />
            {(shown?.duplicateRecords ?? 0) > 0 && (
              <p className="text-muted-foreground text-xs">
                {t('import.duplicates', { count: shown?.duplicateRecords })}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="bg-muted/50 flex gap-3 rounded-lg p-4">
          <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
          <div className="text-muted-foreground space-y-2 text-sm">
            <p className="text-foreground font-medium">{t('import.howItWorks')}</p>
            <p>{t('import.howItWorksDesc')}</p>
          </div>
        </div>

        <div className="border-warning/20 bg-warning/5 flex gap-3 rounded-lg border p-4">
          <AlertTriangle className="text-warning mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-2 text-sm">
            <p className="font-medium">{t('import.recordsMayBeSkipped')}</p>
            <ul className="text-muted-foreground list-inside list-disc space-y-1">
              <li>{t('import.skipUserNotFoundTofa')}</li>
              <li>{t('import.skipDuplicateTofa')}</li>
              <li>{t('import.skipActiveTofa')}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
