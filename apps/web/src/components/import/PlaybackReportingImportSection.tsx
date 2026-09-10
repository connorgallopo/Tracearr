import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Download,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  Info,
  Search,
} from 'lucide-react';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { StepBadge } from '@/components/settings/shared/StepBadge';
import { TimezoneSelect } from '@/components/settings/shared/TimezoneSelect';
import { api } from '@/lib/api';
import { ImportProgressCard, type ImportProgressData } from './ImportProgressCard';
import type { Server, PlaybackReportingImportProgress } from '@tracearr/shared';

interface PlaybackReportingImportSectionProps {
  jellyfinServers: Server[];
  selectedServerId: string;
  onServerChange: (id: string) => void;
  progress: PlaybackReportingImportProgress | null;
  isImporting: boolean;
  onStartImport: (opts: {
    serverId: string;
    timezone: string;
    enrichMedia: boolean;
    importFullRange: boolean;
  }) => void;
}

type PluginCheckState = 'idle' | 'checking' | 'installed' | 'not-installed';

export function PlaybackReportingImportSection({
  jellyfinServers,
  selectedServerId,
  onServerChange,
  progress,
  isImporting,
  onStartImport,
}: PlaybackReportingImportSectionProps) {
  const { t } = useTranslation(['settings', 'common']);

  const [checkState, setCheckState] = useState<PluginCheckState>('idle');
  const [checkMessage, setCheckMessage] = useState('');
  const [checkRecords, setCheckRecords] = useState<number | undefined>();
  const [checkOldestDate, setCheckOldestDate] = useState<string | undefined>();
  const [checkNewestDate, setCheckNewestDate] = useState<string | undefined>();

  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [enrichMedia, setEnrichMedia] = useState(true);
  const [importFullRange, setImportFullRange] = useState(false);

  const handleCheckPlugin = async () => {
    if (!selectedServerId) return;

    setCheckState('checking');
    try {
      const result = await api.import.playbackReporting.test(selectedServerId);
      setCheckMessage(result.message);
      setCheckRecords(result.records);
      setCheckOldestDate(result.oldestDate);
      setCheckNewestDate(result.newestDate);
      setCheckState(result.success && result.installed ? 'installed' : 'not-installed');
    } catch (err) {
      setCheckState('not-installed');
      setCheckMessage(err instanceof Error ? err.message : 'Connection failed');
    }
  };

  const handleStart = () => {
    if (!selectedServerId) return;
    onStartImport({ serverId: selectedServerId, timezone, enrichMedia, importFullRange });
  };

  const progressData: ImportProgressData | null = progress
    ? {
        status: progress.status,
        message: progress.message,
        totalRecords: progress.totalRecords,
        processedRecords: progress.processedRecords,
        importedRecords: progress.importedRecords,
        skippedRecords: progress.skippedRecords,
        errorRecords: progress.errorRecords,
        enrichedRecords: progress.enrichedRecords,
        filteredRecords: progress.filteredRecords,
        waitingFor: progress.waitingFor,
      }
    : null;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h4 className="text-sm font-semibold">{t('import.playbackReporting')}</h4>
        <p className="text-muted-foreground text-sm">{t('import.playbackReportingDesc')}</p>
      </div>

      {/* Server Selection + Plugin Check */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <StepBadge n={1} />
          {t('import.selectTargetServer')}
        </div>

        <div className="ml-8 space-y-4">
          <Select value={selectedServerId} onValueChange={onServerChange}>
            <SelectTrigger>
              <SelectValue placeholder={t('import.selectJellyfinServer')} />
            </SelectTrigger>
            <SelectContent>
              {jellyfinServers.map((server) => (
                <SelectItem key={server.id} value={server.id}>
                  <div className="flex items-center gap-2">
                    <MediaServerIcon type={server.type} className="h-4 w-4" />
                    {server.name}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={handleCheckPlugin}
              disabled={!selectedServerId || checkState === 'checking'}
            >
              {checkState === 'checking' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('import.checkingPlugin')}
                </>
              ) : (
                <>
                  <Search className="mr-2 h-4 w-4" />
                  {t('import.checkPlugin')}
                </>
              )}
            </Button>

            {checkState === 'installed' && (
              <span className="flex items-center gap-1 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                {t('import.pluginFound', {
                  records: (checkRecords ?? 0).toLocaleString(),
                  oldestDate: checkOldestDate ?? '',
                  newestDate: checkNewestDate ?? '',
                })}
              </span>
            )}

            {checkState === 'not-installed' && (
              <span className="text-destructive flex items-center gap-1 text-sm">
                <XCircle className="h-4 w-4" />
                {t('import.pluginNotInstalled')}
              </span>
            )}
          </div>

          {checkState === 'not-installed' && checkMessage && (
            <p className="text-muted-foreground text-xs">{checkMessage}</p>
          )}
        </div>
      </div>

      {/* Options */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <StepBadge n={2} />
          {t('import.importOptions')}
        </div>

        <div className="ml-8 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pr-timezone">{t('import.serverTimezone')}</Label>
            <TimezoneSelect id="pr-timezone" value={timezone} onChange={setTimezone} />
            <p className="text-muted-foreground text-xs">{t('import.serverTimezoneHelp')}</p>
          </div>

          <div className="flex items-start space-x-3">
            <Checkbox
              id="prEnrichMedia"
              checked={enrichMedia}
              onCheckedChange={(checked: boolean | 'indeterminate') =>
                setEnrichMedia(checked === true)
              }
              disabled={isImporting}
            />
            <div className="space-y-1">
              <Label htmlFor="prEnrichMedia" className="cursor-pointer text-sm font-normal">
                {t('import.enrichMetadata')}
              </Label>
              <p className="text-muted-foreground text-xs">{t('import.enrichMetadataHelp')}</p>
            </div>
          </div>

          <div className="flex items-start space-x-3">
            <Checkbox
              id="prImportFullRange"
              checked={importFullRange}
              onCheckedChange={(checked: boolean | 'indeterminate') =>
                setImportFullRange(checked === true)
              }
              disabled={isImporting}
            />
            <div className="space-y-1">
              <Label htmlFor="prImportFullRange" className="cursor-pointer text-sm font-normal">
                {t('import.importFullRange')}
              </Label>
              <p className="text-muted-foreground text-xs">{t('import.importFullRangeHelp')}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Import Button */}
      <div className="border-t pt-6">
        <Button onClick={handleStart} disabled={!selectedServerId || isImporting} size="lg">
          {isImporting ? (
            <>
              <Loader2 className="animate-spin" />
              {t('import.importing')}
            </>
          ) : (
            <>
              <Download className="mr-2 h-4 w-4" />
              {t('import.startImport')}
            </>
          )}
        </Button>

        {progressData && (
          <div className="mt-4 space-y-2">
            <ImportProgressCard progress={progressData} />
            {(progress?.overlapRecords ?? 0) > 0 || (progress?.duplicateRecords ?? 0) > 0 ? (
              <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {(progress?.overlapRecords ?? 0) > 0 && (
                  <span>{t('import.overlapSkipped', { count: progress?.overlapRecords })}</span>
                )}
                {(progress?.duplicateRecords ?? 0) > 0 && (
                  <span>{t('import.duplicates', { count: progress?.duplicateRecords })}</span>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Info cards */}
      <div className="space-y-3">
        <div className="bg-muted/50 flex gap-3 rounded-lg p-4">
          <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
          <div className="text-muted-foreground space-y-2 text-sm">
            <p className="text-foreground font-medium">{t('import.howItWorks')}</p>
            <p>{t('import.howItWorksDesc')}</p>
          </div>
        </div>

        <div className="flex gap-3 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
          <div className="space-y-2 text-sm">
            <p className="font-medium">{t('import.recordsMayBeSkipped')}</p>
            <ul className="text-muted-foreground list-inside list-disc space-y-1">
              <li>{t('import.skipUserNotFoundJellyfin')}</li>
              <li>{t('import.skipOverlap')}</li>
              <li>{t('import.skipDuplicatePlugin')}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
