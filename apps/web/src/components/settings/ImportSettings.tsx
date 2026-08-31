import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Server as ServerIcon,
  Download,
  CheckCircle2,
  ChevronRight,
  XCircle,
  Loader2,
  AlertTriangle,
  Upload,
  Info,
} from 'lucide-react';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { api } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import {
  ImportProgressCard,
  FileDropzone,
  PlaybackReportingImportSection,
  type ImportProgressData,
} from '@/components/import';
import type {
  Server,
  TautulliImportProgress,
  JellystatImportProgress,
  PlaybackReportingImportProgress,
} from '@tracearr/shared';
import { useSettings, useUpdateSettings, useServers } from '@/hooks/queries';

// Tautulli Import Section Component
interface TautulliImportSectionProps {
  tautulliUrl: string;
  setTautulliUrl: (url: string) => void;
  tautulliApiKey: string;
  setTautulliApiKey: (key: string) => void;
  basicAuthUsername: string;
  setBasicAuthUsername: (username: string) => void;
  basicAuthPassword: string;
  setBasicAuthPassword: (password: string) => void;
  connectionStatus: 'idle' | 'testing' | 'success' | 'error';
  connectionMessage: string;
  handleTestConnection: () => Promise<void>;
  plexServers: Server[];
  selectedPlexServerId: string;
  setSelectedPlexServerId: (id: string) => void;
  isTautulliImporting: boolean;
  overwriteFriendlyNames: boolean;
  setOverwriteFriendlyNames: (overwrite: boolean) => void;
  includeStreamDetails: boolean;
  setIncludeStreamDetails: (include: boolean) => void;
  handleStartTautulliImport: () => Promise<void>;
  tautulliProgressData: ImportProgressData | null;
}

function TautulliImportSection({
  tautulliUrl,
  setTautulliUrl,
  tautulliApiKey,
  setTautulliApiKey,
  basicAuthUsername,
  setBasicAuthUsername,
  basicAuthPassword,
  setBasicAuthPassword,
  connectionStatus,
  connectionMessage,
  handleTestConnection,
  plexServers,
  selectedPlexServerId,
  setSelectedPlexServerId,
  isTautulliImporting,
  overwriteFriendlyNames,
  setOverwriteFriendlyNames,
  includeStreamDetails,
  setIncludeStreamDetails,
  handleStartTautulliImport,
  tautulliProgressData,
}: TautulliImportSectionProps) {
  const { t } = useTranslation(['settings', 'common']);

  return (
    <div className="space-y-6">
      {/* Connection Setup */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs">
            {t('import.step1')}
          </span>
          {t('import.connectToTautulli')}
        </div>

        <div className="ml-8 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tautulliUrl">{t('import.tautulliUrl')}</Label>
            <Input
              id="tautulliUrl"
              placeholder={t('import.tautulliUrlPlaceholder')}
              value={tautulliUrl}
              onChange={(e) => setTautulliUrl(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">{t('import.tautulliUrlHelp')}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tautulliApiKey">{t('common:labels.apiKey')}</Label>
            <PasswordInput
              id="tautulliApiKey"
              placeholder={t('import.apiKeyPlaceholder')}
              value={tautulliApiKey}
              onChange={(e) => setTautulliApiKey(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">{t('import.apiKeyHelp')}</p>
          </div>

          <Collapsible defaultOpen={!!basicAuthUsername || !!basicAuthPassword}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 [&[data-state=open]>svg]:rotate-90"
              >
                <ChevronRight className="transition-transform" />
                {t('import.basicAuth')}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-2">
              <p className="text-muted-foreground text-xs">{t('import.basicAuthHelp')}</p>

              <div className="space-y-2">
                <Label htmlFor="tautulliBasicAuthUsername">{t('import.basicAuthUsername')}</Label>
                <Input
                  id="tautulliBasicAuthUsername"
                  autoComplete="off"
                  placeholder={t('import.basicAuthUsernamePlaceholder')}
                  value={basicAuthUsername}
                  onChange={(e) => setBasicAuthUsername(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="tautulliBasicAuthPassword">{t('import.basicAuthPassword')}</Label>
                <PasswordInput
                  id="tautulliBasicAuthPassword"
                  autoComplete="new-password"
                  placeholder={t('import.basicAuthPasswordPlaceholder')}
                  value={basicAuthPassword}
                  onChange={(e) => setBasicAuthPassword(e.target.value)}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={handleTestConnection}
              disabled={connectionStatus === 'testing' || !tautulliUrl || !tautulliApiKey}
              variant={connectionStatus === 'success' ? 'outline' : 'default'}
            >
              {connectionStatus === 'testing' ? (
                <>
                  <Loader2 className="animate-spin" />
                  {t('import.testing')}
                </>
              ) : connectionStatus === 'success' ? (
                <>
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  {t('common:states.connected')}
                </>
              ) : (
                t('servers.testConnection')
              )}
            </Button>

            {connectionStatus === 'success' && connectionMessage && (
              <span className="text-sm text-green-600">{connectionMessage}</span>
            )}

            {connectionStatus === 'error' && (
              <span className="text-destructive flex items-center gap-1 text-sm">
                <XCircle className="h-4 w-4" />
                {connectionMessage}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Import Section - Only shown when connected */}
      {connectionStatus === 'success' && (
        <>
          <div className="space-y-4 border-t pt-6">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs">
                {t('import.step2')}
              </span>
              {t('import.importHistory')}
            </div>

            <div className="ml-8 space-y-4">
              <div className="space-y-2">
                <Label>{t('import.targetServer')}</Label>
                <Select value={selectedPlexServerId} onValueChange={setSelectedPlexServerId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('import.selectPlexServer')} />
                  </SelectTrigger>
                  <SelectContent>
                    {plexServers.map((server) => (
                      <SelectItem key={server.id} value={server.id}>
                        <div className="flex items-center gap-2">
                          <MediaServerIcon type="plex" className="h-4 w-4" />
                          {server.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-start space-x-3">
                <Checkbox
                  id="overwriteFriendlyNames"
                  checked={overwriteFriendlyNames}
                  onCheckedChange={(checked: boolean | 'indeterminate') =>
                    setOverwriteFriendlyNames(checked === true)
                  }
                  disabled={isTautulliImporting}
                />
                <div className="space-y-1">
                  <Label
                    htmlFor="overwriteFriendlyNames"
                    className="cursor-pointer text-sm font-normal"
                  >
                    {t('import.overwriteFriendlyNames')}
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    {t('import.overwriteFriendlyNamesHelp')}
                  </p>
                </div>
              </div>

              <div className="flex items-start space-x-3">
                <Checkbox
                  id="includeStreamDetails"
                  checked={includeStreamDetails}
                  onCheckedChange={(checked: boolean | 'indeterminate') =>
                    setIncludeStreamDetails(checked === true)
                  }
                  disabled={isTautulliImporting}
                />
                <div className="space-y-1">
                  <Label
                    htmlFor="includeStreamDetails"
                    className="flex cursor-pointer items-center gap-2 text-sm font-normal"
                  >
                    {t('import.includeStreamDetails')}
                    <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-500">
                      {t('common:beta')}
                    </span>
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    {t('import.includeStreamDetailsHelp')}
                  </p>
                </div>
              </div>

              <Button
                onClick={handleStartTautulliImport}
                disabled={!selectedPlexServerId || isTautulliImporting}
                size="lg"
              >
                {isTautulliImporting ? (
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

              {tautulliProgressData && (
                <ImportProgressCard progress={tautulliProgressData} showPageProgress />
              )}
            </div>
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
                  <li>{t('import.skipUserNotFoundPlex')}</li>
                  <li>{t('import.skipDuplicate')}</li>
                  <li>{t('import.skipInProgress')}</li>
                </ul>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Jellystat Import Section Component
interface JellystatImportSectionProps {
  jellyfinEmbyServers: Server[];
  selectedJellyfinServerId: string;
  setSelectedJellyfinServerId: (id: string) => void;
  selectedFile: File | null;
  handleFileSelect: (file: File | null) => void;
  enrichMedia: boolean;
  setEnrichMedia: (enrich: boolean) => void;
  updateStreamDetails: boolean;
  setUpdateStreamDetails: (update: boolean) => void;
  isJellystatImporting: boolean;
  handleStartJellystatImport: () => Promise<void>;
  jellystatProgressData: ImportProgressData | null;
}

function JellystatImportSection({
  jellyfinEmbyServers,
  selectedJellyfinServerId,
  setSelectedJellyfinServerId,
  selectedFile,
  handleFileSelect,
  enrichMedia,
  setEnrichMedia,
  updateStreamDetails,
  setUpdateStreamDetails,
  isJellystatImporting,
  handleStartJellystatImport,
  jellystatProgressData,
}: JellystatImportSectionProps) {
  const { t } = useTranslation(['settings', 'common']);

  return (
    <div className="space-y-6">
      {/* Server Selection */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs">
            {t('import.step1')}
          </span>
          {t('import.selectTargetServer')}
        </div>

        <div className="ml-8 space-y-2">
          <Select value={selectedJellyfinServerId} onValueChange={setSelectedJellyfinServerId}>
            <SelectTrigger>
              <SelectValue placeholder={t('import.selectJellyfinServer')} />
            </SelectTrigger>
            <SelectContent>
              {jellyfinEmbyServers.map((server) => (
                <SelectItem key={server.id} value={server.id}>
                  <div className="flex items-center gap-2">
                    <MediaServerIcon type={server.type} className="h-4 w-4" />
                    {server.name}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* File Upload */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs">
            {t('import.step2')}
          </span>
          {t('import.uploadJellystatBackup')}
        </div>

        <div className="ml-8 space-y-4">
          <FileDropzone
            accept=".json"
            maxSize={500 * 1024 * 1024}
            onFileSelect={handleFileSelect}
            selectedFile={selectedFile}
            disabled={isJellystatImporting}
          />
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
            <p className="text-sm font-medium text-blue-600 dark:text-blue-400">
              {t('import.exportBackupHint')}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">{t('import.exportBackupHelp')}</p>
          </div>
        </div>
      </div>

      {/* Options */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs">
            3
          </span>
          {t('import.importOptions')}
        </div>

        <div className="ml-8 space-y-3">
          <div className="flex items-start space-x-3">
            <Checkbox
              id="enrichMedia"
              checked={enrichMedia}
              onCheckedChange={(checked: boolean | 'indeterminate') =>
                setEnrichMedia(checked === true)
              }
              disabled={isJellystatImporting}
            />
            <div className="space-y-1">
              <Label htmlFor="enrichMedia" className="cursor-pointer text-sm font-normal">
                {t('import.enrichMetadata')}
              </Label>
              <p className="text-muted-foreground text-xs">{t('import.enrichMetadataHelp')}</p>
            </div>
          </div>
          <div className="flex items-start space-x-3">
            <Checkbox
              id="updateStreamDetails"
              checked={updateStreamDetails}
              onCheckedChange={(checked: boolean | 'indeterminate') =>
                setUpdateStreamDetails(checked === true)
              }
              disabled={isJellystatImporting}
            />
            <div className="space-y-1">
              <Label htmlFor="updateStreamDetails" className="cursor-pointer text-sm font-normal">
                {t('import.updateExistingRecords')}
              </Label>
              <p className="text-muted-foreground text-xs">
                {t('import.updateExistingRecordsHelp')}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Import Button */}
      <div className="border-t pt-6">
        <Button
          onClick={handleStartJellystatImport}
          disabled={!selectedJellyfinServerId || !selectedFile || isJellystatImporting}
          size="lg"
        >
          {isJellystatImporting ? (
            <>
              <Loader2 className="animate-spin" />
              {t('import.importing')}
            </>
          ) : (
            <>
              <Upload className="mr-2 h-4 w-4" />
              {t('import.startImport')}
            </>
          )}
        </Button>

        {jellystatProgressData && (
          <div className="mt-4">
            <ImportProgressCard progress={jellystatProgressData} />
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
              <li>{t('import.skipDuplicate')}</li>
            </ul>
            <p className="text-muted-foreground pt-1">{t('import.skipSyncHint')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ImportSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const { data: serversData, isLoading: serversLoading } = useServers();
  const updateSettings = useUpdateSettings();
  const { socket } = useSocket();

  // Tautulli state
  const [tautulliUrl, setTautulliUrl] = useState('');
  const [tautulliApiKey, setTautulliApiKey] = useState('');
  const [basicAuthUsername, setBasicAuthUsername] = useState('');
  const [basicAuthPassword, setBasicAuthPassword] = useState('');
  const [selectedPlexServerId, setSelectedPlexServerId] = useState<string>('');
  const [connectionStatus, setConnectionStatus] = useState<
    'idle' | 'testing' | 'success' | 'error'
  >('idle');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [tautulliProgress, setTautulliProgress] = useState<TautulliImportProgress | null>(null);
  const [isTautulliImporting, setIsTautulliImporting] = useState(false);
  const [overwriteFriendlyNames, setOverwriteFriendlyNames] = useState(false);
  const [includeStreamDetails, setIncludeStreamDetails] = useState(false);
  const [_tautulliActiveJobId, setTautulliActiveJobId] = useState<string | null>(null);

  // Jellystat state
  const [selectedJellyfinServerId, setSelectedJellyfinServerId] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [enrichMedia, setEnrichMedia] = useState(true);
  const [updateStreamDetails, setUpdateStreamDetails] = useState(false);
  const [jellystatProgress, setJellystatProgress] = useState<JellystatImportProgress | null>(null);
  const [isJellystatImporting, setIsJellystatImporting] = useState(false);
  const [_jellystatActiveJobId, setJellystatActiveJobId] = useState<string | null>(null);

  // Playback Reporting state
  const [playbackReportingProgress, setPlaybackReportingProgress] =
    useState<PlaybackReportingImportProgress | null>(null);
  const [isPlaybackReportingImporting, setIsPlaybackReportingImporting] = useState(false);
  const [_playbackReportingActiveJobId, setPlaybackReportingActiveJobId] = useState<string | null>(
    null
  );

  // Handle both array and wrapped response formats
  const servers = Array.isArray(serversData)
    ? serversData
    : ((serversData as unknown as { data?: Server[] })?.data ?? []);

  // Split servers by type
  const plexServers = servers.filter((s) => s.type === 'plex');
  const jellyfinEmbyServers = servers.filter((s) => s.type === 'jellyfin' || s.type === 'emby');

  // Initialize form with saved settings
  useEffect(() => {
    if (settings) {
      setTautulliUrl(settings.tautulliUrl ?? '');
      setTautulliApiKey(settings.tautulliApiKey ?? '');
      setBasicAuthUsername(settings.tautulliBasicAuthUsername ?? '');
      setBasicAuthPassword(settings.tautulliBasicAuthPassword ?? '');
      if (settings.tautulliUrl && settings.tautulliApiKey) {
        setConnectionStatus('success');
      }
    }
  }, [settings]);

  // Check for active Tautulli import on mount
  useEffect(() => {
    if (plexServers.length === 0) return;

    const checkActiveImports = async () => {
      for (const server of plexServers) {
        try {
          const result = await api.import.tautulli.getActive(server.id);
          if (result.active && result.jobId) {
            setSelectedPlexServerId(server.id);
            setTautulliActiveJobId(result.jobId);
            setIsTautulliImporting(true);

            const progressPercent = typeof result.progress === 'number' ? result.progress : 0;
            setTautulliProgress({
              status: 'processing',
              totalRecords: 0,
              fetchedRecords: 0,
              processedRecords: 0,
              importedRecords: 0,
              updatedRecords: 0,
              skippedRecords: 0,
              duplicateRecords: 0,
              unknownUserRecords: 0,
              activeSessionRecords: 0,
              errorRecords: 0,
              currentPage: 0,
              totalPages: 0,
              message:
                progressPercent > 0
                  ? t('import.importInProgressPercent', { percent: progressPercent })
                  : t('import.importInProgressGeneric'),
            });
            setConnectionStatus('success');
            break;
          }
        } catch {
          // Ignore errors
        }
      }
    };

    void checkActiveImports();
  }, [plexServers.length]);

  // Check for active Jellystat import on mount
  useEffect(() => {
    if (jellyfinEmbyServers.length === 0) return;

    const checkActiveJellystatImports = async () => {
      for (const server of jellyfinEmbyServers) {
        try {
          const result = await api.import.jellystat.getActive(server.id);
          if (result.active && result.jobId) {
            setSelectedJellyfinServerId(server.id);
            setJellystatActiveJobId(result.jobId);
            setIsJellystatImporting(true);

            const progressPercent = typeof result.progress === 'number' ? result.progress : 0;
            setJellystatProgress({
              status: 'processing',
              totalRecords: 0,
              processedRecords: 0,
              importedRecords: 0,
              skippedRecords: 0,
              errorRecords: 0,
              filteredRecords: 0,
              enrichedRecords: 0,
              message:
                progressPercent > 0
                  ? t('import.importInProgressPercent', { percent: progressPercent })
                  : t('import.importInProgressGeneric'),
            });
            break;
          }
        } catch {
          // Ignore errors
        }
      }
    };

    void checkActiveJellystatImports();
  }, [jellyfinEmbyServers.length]);

  // Check for active Playback Reporting import on mount
  useEffect(() => {
    if (jellyfinEmbyServers.length === 0) return;

    const checkActivePlaybackReportingImports = async () => {
      for (const server of jellyfinEmbyServers) {
        try {
          const result = await api.import.playbackReporting.getActive(server.id);
          if (result.active && result.jobId) {
            setSelectedJellyfinServerId(server.id);
            setPlaybackReportingActiveJobId(result.jobId);
            setIsPlaybackReportingImporting(true);

            const progressPercent = typeof result.progress === 'number' ? result.progress : 0;
            setPlaybackReportingProgress({
              status: 'processing',
              totalRecords: 0,
              fetchedRecords: 0,
              processedRecords: 0,
              importedRecords: 0,
              skippedRecords: 0,
              duplicateRecords: 0,
              unknownUserRecords: 0,
              overlapRecords: 0,
              filteredRecords: 0,
              errorRecords: 0,
              enrichedRecords: 0,
              message:
                progressPercent > 0
                  ? t('import.importInProgressPercent', { percent: progressPercent })
                  : t('import.importInProgressGeneric'),
            });
            break;
          }
        } catch {
          // Ignore errors
        }
      }
    };

    void checkActivePlaybackReportingImports();
  }, [jellyfinEmbyServers.length]);

  // Listen for Tautulli import progress via WebSocket
  useEffect(() => {
    if (!socket) return;

    const handleTautulliProgress = (progress: TautulliImportProgress) => {
      setTautulliProgress(progress);
      if (progress.status === 'complete' || progress.status === 'error') {
        setIsTautulliImporting(false);
        setTautulliActiveJobId(null);
      }
    };

    socket.on('import:progress', handleTautulliProgress);
    return () => {
      socket.off('import:progress', handleTautulliProgress);
    };
  }, [socket]);

  // Listen for Jellystat import progress via WebSocket
  useEffect(() => {
    if (!socket) return;

    const handleJellystatProgress = (progress: JellystatImportProgress) => {
      setJellystatProgress(progress);
      if (progress.status === 'complete' || progress.status === 'error') {
        setIsJellystatImporting(false);
        setJellystatActiveJobId(null);
        setSelectedFile(null);
      }
    };

    socket.on('import:jellystat:progress', handleJellystatProgress);
    return () => {
      socket.off('import:jellystat:progress', handleJellystatProgress);
    };
  }, [socket]);

  // Listen for Playback Reporting import progress via WebSocket
  useEffect(() => {
    if (!socket) return;

    const handlePlaybackReportingProgress = (progress: PlaybackReportingImportProgress) => {
      setPlaybackReportingProgress(progress);
      if (progress.status === 'complete' || progress.status === 'error') {
        setIsPlaybackReportingImporting(false);
        setPlaybackReportingActiveJobId(null);
      }
    };

    socket.on('import:playbackreporting:progress', handlePlaybackReportingProgress);
    return () => {
      socket.off('import:playbackreporting:progress', handlePlaybackReportingProgress);
    };
  }, [socket]);

  const handleSaveSettings = () => {
    updateSettings.mutate({
      tautulliUrl: tautulliUrl || null,
      tautulliApiKey: tautulliApiKey || null,
      tautulliBasicAuthUsername: basicAuthUsername || null,
      tautulliBasicAuthPassword: basicAuthPassword || null,
    });
  };

  const handleTestConnection = async () => {
    if (!tautulliUrl || !tautulliApiKey) {
      setConnectionStatus('error');
      setConnectionMessage(t('import.pleaseEnterDetails'));
      return;
    }

    setConnectionStatus('testing');
    setConnectionMessage(t('import.testingConnection'));

    try {
      const result = await api.import.tautulli.test(
        tautulliUrl,
        tautulliApiKey,
        basicAuthUsername ? { username: basicAuthUsername, password: basicAuthPassword } : undefined
      );
      if (result.success) {
        setConnectionStatus('success');
        setConnectionMessage(
          t('import.connectedFound', {
            users: result.users ?? 0,
            records: (result.historyRecords ?? 0).toLocaleString(),
          })
        );
        handleSaveSettings();
      } else {
        setConnectionStatus('error');
        setConnectionMessage(result.message || 'Connection failed');
      }
    } catch (err) {
      setConnectionStatus('error');
      setConnectionMessage(err instanceof Error ? err.message : 'Connection failed');
    }
  };

  const handleStartTautulliImport = async () => {
    if (!selectedPlexServerId) return;

    setIsTautulliImporting(true);
    setTautulliProgress({
      status: 'fetching',
      totalRecords: 0,
      fetchedRecords: 0,
      processedRecords: 0,
      importedRecords: 0,
      updatedRecords: 0,
      skippedRecords: 0,
      duplicateRecords: 0,
      unknownUserRecords: 0,
      activeSessionRecords: 0,
      errorRecords: 0,
      currentPage: 0,
      totalPages: 0,
      message: t('import.startingImport'),
    });

    try {
      const result = await api.import.tautulli.start(
        selectedPlexServerId,
        overwriteFriendlyNames,
        includeStreamDetails
      );
      if (result.jobId) {
        setTautulliActiveJobId(result.jobId);
      }
    } catch (err) {
      setIsTautulliImporting(false);
      setTautulliActiveJobId(null);
      setTautulliProgress({
        status: 'error',
        totalRecords: 0,
        fetchedRecords: 0,
        processedRecords: 0,
        importedRecords: 0,
        updatedRecords: 0,
        skippedRecords: 0,
        duplicateRecords: 0,
        unknownUserRecords: 0,
        activeSessionRecords: 0,
        errorRecords: 0,
        currentPage: 0,
        totalPages: 0,
        message: err instanceof Error ? err.message : 'Import failed',
      });
    }
  };

  const handleFileSelect = (file: File | null) => {
    if (file && !file.name.endsWith('.json')) {
      setJellystatProgress({
        status: 'error',
        totalRecords: 0,
        processedRecords: 0,
        importedRecords: 0,
        skippedRecords: 0,
        errorRecords: 0,
        filteredRecords: 0,
        enrichedRecords: 0,
        message: t('import.pleaseSelectJsonFile'),
      });
      return;
    }
    setSelectedFile(file);
    if (file) {
      setJellystatProgress(null);
    }
  };

  const handleStartJellystatImport = async () => {
    if (!selectedJellyfinServerId || !selectedFile) return;

    setIsJellystatImporting(true);
    setJellystatProgress({
      status: 'processing',
      totalRecords: 0,
      processedRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      errorRecords: 0,
      filteredRecords: 0,
      enrichedRecords: 0,
      message: t('import.uploadingBackup'),
    });

    try {
      const result = await api.import.jellystat.start(
        selectedJellyfinServerId,
        selectedFile,
        enrichMedia,
        updateStreamDetails
      );
      if (result.jobId) {
        setJellystatActiveJobId(result.jobId);
      }
    } catch (err) {
      setIsJellystatImporting(false);
      setJellystatActiveJobId(null);
      setJellystatProgress({
        status: 'error',
        totalRecords: 0,
        processedRecords: 0,
        importedRecords: 0,
        skippedRecords: 0,
        errorRecords: 0,
        filteredRecords: 0,
        enrichedRecords: 0,
        message: err instanceof Error ? err.message : 'Import failed',
      });
    }
  };

  const handleStartPlaybackReportingImport = async (opts: {
    serverId: string;
    timezone: string;
    enrichMedia: boolean;
    importFullRange: boolean;
  }) => {
    setIsPlaybackReportingImporting(true);
    setPlaybackReportingProgress({
      status: 'fetching',
      totalRecords: 0,
      fetchedRecords: 0,
      processedRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      duplicateRecords: 0,
      unknownUserRecords: 0,
      overlapRecords: 0,
      filteredRecords: 0,
      errorRecords: 0,
      enrichedRecords: 0,
      message: t('import.startingImport'),
    });

    try {
      const result = await api.import.playbackReporting.start(
        opts.serverId,
        opts.timezone,
        opts.enrichMedia,
        opts.importFullRange
      );
      if (result.jobId) {
        setPlaybackReportingActiveJobId(result.jobId);
      }
    } catch (err) {
      setIsPlaybackReportingImporting(false);
      setPlaybackReportingActiveJobId(null);
      setPlaybackReportingProgress({
        status: 'error',
        totalRecords: 0,
        fetchedRecords: 0,
        processedRecords: 0,
        importedRecords: 0,
        skippedRecords: 0,
        duplicateRecords: 0,
        unknownUserRecords: 0,
        overlapRecords: 0,
        filteredRecords: 0,
        errorRecords: 0,
        enrichedRecords: 0,
        message: err instanceof Error ? err.message : 'Import failed',
      });
    }
  };

  // Convert progress types for the reusable component
  const tautulliProgressData: ImportProgressData | null = tautulliProgress
    ? {
        status: tautulliProgress.status === 'fetching' ? 'fetching' : tautulliProgress.status,
        message: tautulliProgress.message,
        totalRecords: tautulliProgress.totalRecords,
        processedRecords: tautulliProgress.processedRecords,
        importedRecords: tautulliProgress.importedRecords,
        skippedRecords: tautulliProgress.skippedRecords,
        errorRecords: tautulliProgress.errorRecords,
        currentPage: tautulliProgress.currentPage,
        totalPages: tautulliProgress.totalPages,
      }
    : null;

  const jellystatProgressData: ImportProgressData | null = jellystatProgress
    ? {
        status:
          jellystatProgress.status === 'parsing' || jellystatProgress.status === 'enriching'
            ? 'processing'
            : jellystatProgress.status,
        message: jellystatProgress.message,
        totalRecords: jellystatProgress.totalRecords,
        processedRecords: jellystatProgress.processedRecords,
        importedRecords: jellystatProgress.importedRecords,
        skippedRecords: jellystatProgress.skippedRecords,
        filteredRecords: jellystatProgress.filteredRecords,
        errorRecords: jellystatProgress.errorRecords,
        enrichedRecords: jellystatProgress.enrichedRecords,
      }
    : null;

  if (settingsLoading || serversLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  const hasPlexServers = plexServers.length > 0;
  const hasJellyfinEmbyServers = jellyfinEmbyServers.length > 0;
  const hasBothServerTypes = hasPlexServers && hasJellyfinEmbyServers;

  // Determine default tab based on available server types
  const defaultTab = hasPlexServers ? 'plex' : 'jellyfin';

  // No servers state
  if (!hasPlexServers && !hasJellyfinEmbyServers) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            {t('import.importHistory')}
          </CardTitle>
          <CardDescription>{t('import.importHistoryDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8">
            <ServerIcon className="text-muted-foreground h-8 w-8" />
            <div className="text-center">
              <p className="font-medium">{t('import.noServers')}</p>
              <p className="text-muted-foreground mt-1 text-sm">{t('import.noServersHint')}</p>
            </div>
            <Button variant="outline" asChild>
              <a href="/settings/servers">{t('servers.addServer')}</a>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="h-5 w-5" />
          {t('import.importHistory')}
        </CardTitle>
        <CardDescription>{t('import.importHistoryDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        {hasBothServerTypes ? (
          <Tabs defaultValue={defaultTab} className="w-full">
            <TabsList className="mb-6 grid w-full grid-cols-2">
              <TabsTrigger value="plex" className="flex items-center gap-2">
                <MediaServerIcon type="plex" className="h-4 w-4" />
                {t('import.plex')}
              </TabsTrigger>
              <TabsTrigger value="jellyfin" className="flex items-center gap-2">
                <MediaServerIcon type="jellyfin" className="h-4 w-4" />
                {t('import.jellyfinEmby')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="plex" className="mt-0 space-y-6">
              <TautulliImportSection
                tautulliUrl={tautulliUrl}
                setTautulliUrl={setTautulliUrl}
                tautulliApiKey={tautulliApiKey}
                setTautulliApiKey={setTautulliApiKey}
                basicAuthUsername={basicAuthUsername}
                setBasicAuthUsername={setBasicAuthUsername}
                basicAuthPassword={basicAuthPassword}
                setBasicAuthPassword={setBasicAuthPassword}
                connectionStatus={connectionStatus}
                connectionMessage={connectionMessage}
                handleTestConnection={handleTestConnection}
                plexServers={plexServers}
                selectedPlexServerId={selectedPlexServerId}
                setSelectedPlexServerId={setSelectedPlexServerId}
                isTautulliImporting={isTautulliImporting}
                overwriteFriendlyNames={overwriteFriendlyNames}
                setOverwriteFriendlyNames={setOverwriteFriendlyNames}
                includeStreamDetails={includeStreamDetails}
                setIncludeStreamDetails={setIncludeStreamDetails}
                handleStartTautulliImport={handleStartTautulliImport}
                tautulliProgressData={tautulliProgressData}
              />
            </TabsContent>

            <TabsContent value="jellyfin" className="mt-0 space-y-6">
              <PlaybackReportingImportSection
                jellyfinServers={jellyfinEmbyServers}
                selectedServerId={selectedJellyfinServerId}
                onServerChange={setSelectedJellyfinServerId}
                progress={playbackReportingProgress}
                isImporting={isPlaybackReportingImporting}
                onStartImport={handleStartPlaybackReportingImport}
              />

              <div className="border-t pt-6">
                <JellystatImportSection
                  jellyfinEmbyServers={jellyfinEmbyServers}
                  selectedJellyfinServerId={selectedJellyfinServerId}
                  setSelectedJellyfinServerId={setSelectedJellyfinServerId}
                  selectedFile={selectedFile}
                  handleFileSelect={handleFileSelect}
                  enrichMedia={enrichMedia}
                  setEnrichMedia={setEnrichMedia}
                  updateStreamDetails={updateStreamDetails}
                  setUpdateStreamDetails={setUpdateStreamDetails}
                  isJellystatImporting={isJellystatImporting}
                  handleStartJellystatImport={handleStartJellystatImport}
                  jellystatProgressData={jellystatProgressData}
                />
              </div>
            </TabsContent>
          </Tabs>
        ) : hasPlexServers ? (
          <TautulliImportSection
            tautulliUrl={tautulliUrl}
            setTautulliUrl={setTautulliUrl}
            tautulliApiKey={tautulliApiKey}
            setTautulliApiKey={setTautulliApiKey}
            basicAuthUsername={basicAuthUsername}
            setBasicAuthUsername={setBasicAuthUsername}
            basicAuthPassword={basicAuthPassword}
            setBasicAuthPassword={setBasicAuthPassword}
            connectionStatus={connectionStatus}
            connectionMessage={connectionMessage}
            handleTestConnection={handleTestConnection}
            plexServers={plexServers}
            selectedPlexServerId={selectedPlexServerId}
            setSelectedPlexServerId={setSelectedPlexServerId}
            isTautulliImporting={isTautulliImporting}
            overwriteFriendlyNames={overwriteFriendlyNames}
            setOverwriteFriendlyNames={setOverwriteFriendlyNames}
            includeStreamDetails={includeStreamDetails}
            setIncludeStreamDetails={setIncludeStreamDetails}
            handleStartTautulliImport={handleStartTautulliImport}
            tautulliProgressData={tautulliProgressData}
          />
        ) : (
          <div className="space-y-6">
            <PlaybackReportingImportSection
              jellyfinServers={jellyfinEmbyServers}
              selectedServerId={selectedJellyfinServerId}
              onServerChange={setSelectedJellyfinServerId}
              progress={playbackReportingProgress}
              isImporting={isPlaybackReportingImporting}
              onStartImport={handleStartPlaybackReportingImport}
            />

            <div className="border-t pt-6">
              <JellystatImportSection
                jellyfinEmbyServers={jellyfinEmbyServers}
                selectedJellyfinServerId={selectedJellyfinServerId}
                setSelectedJellyfinServerId={setSelectedJellyfinServerId}
                selectedFile={selectedFile}
                handleFileSelect={handleFileSelect}
                enrichMedia={enrichMedia}
                setEnrichMedia={setEnrichMedia}
                updateStreamDetails={updateStreamDetails}
                setUpdateStreamDetails={setUpdateStreamDetails}
                isJellystatImporting={isJellystatImporting}
                handleStartJellystatImport={handleStartJellystatImport}
                jellystatProgressData={jellystatProgressData}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
