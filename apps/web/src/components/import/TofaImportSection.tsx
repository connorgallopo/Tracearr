import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Download, Info, Loader2 } from 'lucide-react';
import { WS_EVENTS, type Server, type TofaImportProgress } from '@tracearr/shared';
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
import { useActiveImport } from '@/hooks/useActiveImport';
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

export function TofaImportSection({
  servers,
  onStarted,
}: {
  servers: Server[];
  onStarted?: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const { socket } = useSocket();
  const [serverId, setServerId] = useState(servers[0]?.id ?? '');
  const [progress, setProgress] = useState<TofaImportProgress | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  useActiveImport(
    servers.map((server) => server.id),
    api.import.tofa.getActive,
    (activeServerId, _jobId, message) => {
      setServerId(activeServerId);
      setIsImporting(true);
      setProgress(blankProgress('processing', message));
    }
  );

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

  const progressData: ImportProgressData | null = progress
    ? {
        status: progress.status,
        message: progress.message,
        totalRecords: progress.fetchedRecords,
        processedRecords: progress.processedRecords,
        importedRecords: progress.importedRecords,
        skippedRecords: progress.skippedRecords,
        errorRecords: progress.errorRecords,
        waitingFor: progress.waitingFor,
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
          <Select value={serverId} onValueChange={setServerId} disabled={isImporting}>
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

      <div className={cn(servers.length > 1 && 'border-t pt-6')}>
        <Button onClick={() => void handleStart()} disabled={!serverId || isImporting} size="lg">
          {isImporting ? (
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

        {progressData && (
          <div className="mt-4 space-y-2">
            <ImportProgressCard progress={progressData} />
            {(progress?.duplicateRecords ?? 0) > 0 && (
              <p className="text-muted-foreground text-xs">
                {t('import.duplicates', { count: progress?.duplicateRecords })}
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
