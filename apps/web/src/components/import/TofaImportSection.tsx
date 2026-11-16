import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Download, Info } from 'lucide-react';
import type { Server, TofaImportProgress, TofaImportResult } from '@tracearr/shared';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import {
  latestImport,
  serverWithImport,
  useActiveImports,
  useImportStatus,
  type CardProgress,
} from '@/hooks/queries/useImports';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ImportProgressCard, type ImportProgressData } from './ImportProgressCard';
import { StartImportButton } from './StartImportButton';

const blankProgress = (
  status: TofaImportProgress['status'],
  message: string
): CardProgress<TofaImportProgress> => ({
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

function resultProgress(result: TofaImportResult): CardProgress<TofaImportProgress> {
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

export function TofaImportSection({
  servers,
  onStarted,
}: {
  servers: Server[];
  onStarted?: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [pickedServerId, setServerId] = useState('');
  const serverIds = servers.map((server) => server.id);
  const imports = useActiveImports('tofa', serverIds);

  // Until the owner picks one, show the server whose import is under way, else one with a result
  const serverId =
    pickedServerId ||
    serverWithImport(serverIds, (id) => latestImport(imports, id)) ||
    (servers[0]?.id ?? '');
  const {
    progress: shown,
    phase,
    start,
  } = useImportStatus(
    'tofa',
    serverId,
    latestImport(imports, serverId),
    { blank: blankProgress, fromResult: resultProgress },
    { onStarted }
  );

  const handleStart = () =>
    start(blankProgress('fetching', t('import.startingImport')), () =>
      api.import.tofa.start(serverId)
    );

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
            disabled={phase === 'pending' || phase === 'importing'}
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

      <div className={cn(servers.length > 1 && 'border-t pt-6')}>
        <StartImportButton
          phase={phase}
          onClick={() => void handleStart()}
          disabled={!serverId}
          icon={Download}
          label={t('import.importTofaHistory')}
        />

        <div className={cn('space-y-2', progressData && phase !== 'pending' && 'mt-4')}>
          <ImportProgressCard progress={progressData} />
          {(shown?.duplicateRecords ?? 0) > 0 && (
            <p className="text-muted-foreground text-xs">
              {t('import.duplicates', { count: shown?.duplicateRecords })}
            </p>
          )}
        </div>
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
