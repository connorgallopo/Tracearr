import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { AlertTriangle, Download, Info } from 'lucide-react';
import type {
  Server,
  ServerHistoryImporter,
  ServerHistoryImportProgress,
  ServerHistoryImportResult,
} from '@tracearr/shared';
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

export const HISTORY_IMPORT_COPY: Record<
  ServerHistoryImporter,
  {
    tab: ParseKeys<'settings'>;
    title: ParseKeys<'settings'>;
    description: ParseKeys<'settings'>;
    selectServer: ParseKeys<'settings'>;
    start: ParseKeys<'settings'>;
    skipUserNotFound: ParseKeys<'settings'>;
    /** Only a server whose history lists plays still running skips them */
    skipActive: ParseKeys<'settings'> | null;
  }
> = {
  tofa: {
    tab: 'import.tofa',
    title: 'import.tofaHistory',
    description: 'import.tofaHistoryDesc',
    selectServer: 'import.selectTofaServer',
    start: 'import.importTofaHistory',
    skipUserNotFound: 'import.skipUserNotFoundTofa',
    skipActive: 'import.skipActiveTofa',
  },
};

const blankProgress = (
  status: ServerHistoryImportProgress['status'],
  message: string
): CardProgress<ServerHistoryImportProgress> => ({
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

function resultProgress(
  result: ServerHistoryImportResult
): CardProgress<ServerHistoryImportProgress> {
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

export function ServerHistoryImportSection({
  importer,
  servers,
  onStarted,
}: {
  importer: ServerHistoryImporter;
  servers: Server[];
  onStarted?: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [pickedServerId, setServerId] = useState('');
  const copy = HISTORY_IMPORT_COPY[importer];
  const serverIds = servers.map((server) => server.id);
  const imports = useActiveImports('serverHistory', serverIds);

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
    'serverHistory',
    serverId,
    latestImport(imports, serverId),
    { blank: blankProgress, fromResult: resultProgress },
    { onStarted }
  );

  const handleStart = () =>
    start(blankProgress('fetching', t('import.startingImport')), () =>
      api.import.serverHistory.start(serverId)
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
        <h4 className="text-sm font-semibold">{t(copy.title)}</h4>
        <p className="text-muted-foreground text-sm">{t(copy.description)}</p>
      </div>

      {servers.length > 1 && (
        <Field>
          <FieldLabel htmlFor={`historyServer-${importer}`}>{t('import.targetServer')}</FieldLabel>
          <Select
            value={serverId}
            onValueChange={setServerId}
            disabled={phase === 'pending' || phase === 'importing'}
          >
            <SelectTrigger id={`historyServer-${importer}`}>
              <SelectValue placeholder={t(copy.selectServer)} />
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
          label={t(copy.start)}
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
              <li>{t(copy.skipUserNotFound)}</li>
              <li>{t('import.skipDuplicateTofa')}</li>
              {copy.skipActive && <li>{t(copy.skipActive)}</li>}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
