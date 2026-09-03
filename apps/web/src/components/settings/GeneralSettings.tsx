/**
 * General settings section - application settings, network, API key, and public API.
 */
import { useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { useTranslation } from 'react-i18next';
import { UpdateChecksCard } from '@/components/settings/UpdateChecksCard';
import { ImageCacheCard } from '@/components/settings/ImageCacheCard';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError } from '@/components/ui/field';
import {
  AutosaveNumberField,
  AutosaveSwitchField,
  SaveStatusIndicator,
} from '@/components/ui/autosave-field';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import {
  RefreshCw,
  ExternalLink,
  Loader2,
  Globe,
  AlertTriangle,
  KeyRound,
  Settings as SettingsIcon,
  Gauge,
} from 'lucide-react';
import { useDebouncedSave, TEXT_INPUT_DELAY } from '@/hooks/useDebouncedSave';
import { useSettings, useApiKey, useRegenerateApiKey } from '@/hooks/queries';

function ApiKeyCard() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: apiKeyData, isLoading } = useApiKey();
  const regenerateApiKey = useRegenerateApiKey();
  const [showConfirm, setShowConfirm] = useState(false);

  const token = apiKeyData?.token;
  const hasKey = !!token;

  const handleRegenerate = () => {
    if (hasKey) {
      setShowConfirm(true);
    } else {
      regenerateApiKey.mutate();
    }
  };

  const confirmRegenerate = () => {
    regenerateApiKey.mutate();
    setShowConfirm(false);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-5 w-5" />
                {t('common:labels.apiKey')}
              </CardTitle>
              <CardDescription>{t('general.apiKeyDesc')}</CardDescription>
            </div>
            <RouterLink to="/api-docs">
              <Button variant="outline" size="sm" className="gap-1.5">
                <ExternalLink className="h-3.5 w-3.5" />
                {t('general.apiDocs')}
              </Button>
            </RouterLink>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={token ?? ''}
                  placeholder={t('general.noApiKeyGenerated')}
                  className="font-mono text-sm"
                />
                <CopyButton
                  value={token ?? ''}
                  label={t('general.copyToClipboard')}
                  disabled={!hasKey}
                />
              </div>
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground text-sm">
                  {hasKey ? t('general.apiKeyReadAccess') : t('general.generateApiKeyPrompt')}
                </p>
                <Button
                  variant={hasKey ? 'outline' : 'default'}
                  size="sm"
                  onClick={handleRegenerate}
                  disabled={regenerateApiKey.isPending}
                >
                  {regenerateApiKey.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  {hasKey ? t('general.regenerate') : t('general.generateKey')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        title={t('general.regenerateApiKey')}
        description={t('general.regenerateApiKeyDesc')}
        confirmLabel={t('general.regenerate')}
        onConfirm={confirmRegenerate}
      />
    </>
  );
}

export function GeneralSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: settings, isLoading } = useSettings();

  // General settings fields
  const pollerEnabledField = useDebouncedSave('pollerEnabled', settings?.pollerEnabled);
  const pollerIntervalField = useDebouncedSave('pollerIntervalMs', settings?.pollerIntervalMs, {
    delay: TEXT_INPUT_DELAY,
    transform: (ms) => Math.max(5000, Math.min(300000, ms)),
  });
  const usePlexGeoipField = useDebouncedSave('usePlexGeoip', settings?.usePlexGeoip);

  // Network settings fields
  const externalUrlField = useDebouncedSave('externalUrl', settings?.externalUrl, {
    delay: TEXT_INPUT_DELAY,
  });
  const intervalSeconds = Math.round((pollerIntervalField.value ?? 15000) / 1000);

  // Public API settings fields
  const watchedThresholdMovieField = useDebouncedSave(
    'watchedThresholdMovie',
    settings?.watchedThresholdMovie,
    { delay: TEXT_INPUT_DELAY, transform: (v) => Math.max(1, Math.min(100, v)) }
  );
  const watchedThresholdTvField = useDebouncedSave(
    'watchedThresholdTv',
    settings?.watchedThresholdTv,
    { delay: TEXT_INPUT_DELAY, transform: (v) => Math.max(1, Math.min(100, v)) }
  );
  const watchedThresholdMusicField = useDebouncedSave(
    'watchedThresholdMusic',
    settings?.watchedThresholdMusic,
    { delay: TEXT_INPUT_DELAY, transform: (v) => Math.max(1, Math.min(100, v)) }
  );
  const apiRateLimitField = useDebouncedSave(
    'publicApiRateLimitPerMinute',
    settings?.publicApiRateLimitPerMinute,
    { delay: TEXT_INPUT_DELAY, transform: (v) => Math.max(1, v) }
  );

  const handleIntervalChange = (seconds: number) => {
    pollerIntervalField.setValue(seconds * 1000);
  };

  const handleDetectUrl = () => {
    let detectedUrl = window.location.origin;
    if (import.meta.env.DEV) {
      detectedUrl = detectedUrl.replace(':5173', ':3000');
    }
    externalUrlField.setValue(detectedUrl);
    setTimeout(() => externalUrlField.saveNow(), 0);
  };

  const externalUrl = externalUrlField.value ?? '';
  const isLocalhost = externalUrl.includes('localhost') || externalUrl.includes('127.0.0.1');
  const isHttp = externalUrl.startsWith('http://') && !isLocalhost;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Application Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SettingsIcon className="h-5 w-5" />
            {t('general.application')}
          </CardTitle>
          <CardDescription>{t('general.applicationDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <AutosaveSwitchField
              id="pollerEnabled"
              label={t('general.sessionSync')}
              description={t('general.sessionSyncDesc')}
              checked={pollerEnabledField.value ?? true}
              onChange={(v) => pollerEnabledField.setValue(v)}
              status={pollerEnabledField.status}
              errorMessage={pollerEnabledField.errorMessage}
              onRetry={pollerEnabledField.retry}
              onReset={pollerEnabledField.reset}
            />

            <AutosaveNumberField
              id="pollerIntervalMs"
              label={t('general.syncInterval')}
              description={t('general.syncIntervalDesc')}
              value={intervalSeconds}
              onChange={handleIntervalChange}
              min={5}
              max={300}
              suffix={t('general.syncIntervalSuffix')}
              disabled={!(pollerEnabledField.value ?? true)}
              status={pollerIntervalField.status}
              errorMessage={pollerIntervalField.errorMessage}
              onRetry={pollerIntervalField.retry}
              onReset={pollerIntervalField.reset}
            />

            <div className="bg-muted/50 space-y-2 rounded-lg p-4">
              <p className="text-muted-foreground text-sm">
                <strong>Plex:</strong> {t('general.plexSseNote')}
              </p>
              <p className="text-muted-foreground text-sm">
                <strong>Jellyfin/Emby:</strong> {t('general.jellyfinPollingNote')}
              </p>
            </div>

            <AutosaveSwitchField
              id="usePlexGeoip"
              label={t('general.enhancedGeoIP')}
              description={t('general.enhancedGeoIPDesc')}
              checked={usePlexGeoipField.value ?? false}
              onChange={(v) => usePlexGeoipField.setValue(v)}
              status={usePlexGeoipField.status}
              errorMessage={usePlexGeoipField.errorMessage}
              onRetry={usePlexGeoipField.retry}
              onReset={usePlexGeoipField.reset}
            />
          </FieldGroup>
        </CardContent>
      </Card>

      {/* Network / External Access */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            {t('general.externalAccess')}
          </CardTitle>
          <CardDescription>{t('general.externalAccessDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="externalUrl">{t('general.externalUrl')}</FieldLabel>
                <SaveStatusIndicator status={externalUrlField.status} />
              </div>
              <div className="flex gap-2">
                <Input
                  id="externalUrl"
                  placeholder={t('general.externalUrlPlaceholder')}
                  value={externalUrlField.value ?? ''}
                  onChange={(e) => externalUrlField.setValue(e.target.value)}
                  aria-invalid={externalUrlField.status === 'error'}
                />
                <Button variant="outline" onClick={handleDetectUrl}>
                  {t('general.detect')}
                </Button>
              </div>
              <FieldDescription>{t('general.externalUrlDesc')}</FieldDescription>
              {externalUrlField.status === 'error' && externalUrlField.errorMessage && (
                <div className="flex items-center justify-between">
                  <FieldError>{externalUrlField.errorMessage}</FieldError>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={externalUrlField.retry}
                      className="h-6 px-2 text-xs"
                    >
                      {t('common:actions.retry')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={externalUrlField.reset}
                      className="h-6 px-2 text-xs"
                    >
                      {t('common:actions.reset')}
                    </Button>
                  </div>
                </div>
              )}
              {isLocalhost && (
                <div className="flex items-start gap-2 rounded-lg bg-yellow-500/10 p-3 text-sm text-yellow-600 dark:text-yellow-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{t('general.localhostWarning')}</span>
                </div>
              )}
              {isHttp && (
                <div className="flex items-start gap-2 rounded-lg bg-yellow-500/10 p-3 text-sm text-yellow-600 dark:text-yellow-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{t('general.iosHttpWarning')}</span>
                </div>
              )}
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      {/* Update checks */}
      <UpdateChecksCard />

      {/* Poster cache */}
      <ImageCacheCard />

      {/* API Key */}
      <ApiKeyCard />

      {/* Public API */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="h-5 w-5" />
            {t('general.publicApiSettings')}
          </CardTitle>
          <CardDescription>{t('general.publicApiSettingsDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <AutosaveNumberField
              id="watchedThresholdMovie"
              label={t('general.watchedThresholdMovie')}
              description={t('general.watchedThresholdMovieDesc')}
              value={watchedThresholdMovieField.value ?? 85}
              onChange={(v) => watchedThresholdMovieField.setValue(v)}
              min={1}
              max={100}
              suffix={t('general.watchedThresholdSuffix')}
              status={watchedThresholdMovieField.status}
              errorMessage={watchedThresholdMovieField.errorMessage}
              onRetry={watchedThresholdMovieField.retry}
              onReset={watchedThresholdMovieField.reset}
            />

            <AutosaveNumberField
              id="watchedThresholdTv"
              label={t('general.watchedThresholdTv')}
              description={t('general.watchedThresholdTvDesc')}
              value={watchedThresholdTvField.value ?? 85}
              onChange={(v) => watchedThresholdTvField.setValue(v)}
              min={1}
              max={100}
              suffix={t('general.watchedThresholdSuffix')}
              status={watchedThresholdTvField.status}
              errorMessage={watchedThresholdTvField.errorMessage}
              onRetry={watchedThresholdTvField.retry}
              onReset={watchedThresholdTvField.reset}
            />

            <AutosaveNumberField
              id="watchedThresholdMusic"
              label={t('general.watchedThresholdMusic')}
              description={t('general.watchedThresholdMusicDesc')}
              value={watchedThresholdMusicField.value ?? 85}
              onChange={(v) => watchedThresholdMusicField.setValue(v)}
              min={1}
              max={100}
              suffix={t('general.watchedThresholdSuffix')}
              status={watchedThresholdMusicField.status}
              errorMessage={watchedThresholdMusicField.errorMessage}
              onRetry={watchedThresholdMusicField.retry}
              onReset={watchedThresholdMusicField.reset}
            />

            <AutosaveNumberField
              id="publicApiRateLimitPerMinute"
              label={t('general.apiRateLimit')}
              description={t('general.apiRateLimitDesc')}
              value={apiRateLimitField.value ?? 240}
              onChange={(v) => apiRateLimitField.setValue(v)}
              min={1}
              suffix={t('general.apiRateLimitSuffix')}
              status={apiRateLimitField.status}
              errorMessage={apiRateLimitField.errorMessage}
              onRetry={apiRateLimitField.retry}
              onReset={apiRateLimitField.reset}
            />
          </FieldGroup>
        </CardContent>
      </Card>
    </div>
  );
}
