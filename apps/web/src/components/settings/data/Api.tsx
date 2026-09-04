import { useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { ExternalLink, Gauge, KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { FieldGroup } from '@/components/ui/field';
import { PasswordInput } from '@/components/ui/password-input';
import { Skeleton } from '@/components/ui/skeleton';
import { AutosaveNumberField } from '@/components/ui/autosave-field';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { useApiKey, useRegenerateApiKey, useSettings } from '@/hooks/queries';
import { TEXT_INPUT_DELAY, useDebouncedSave } from '@/hooks/useDebouncedSave';

function ApiKeyCard() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: apiKeyData, isLoading } = useApiKey();
  const regenerateApiKey = useRegenerateApiKey();
  const [showConfirm, setShowConfirm] = useState(false);

  const token = apiKeyData?.token;
  const hasKey = !!token;

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
            <Skeleton className="h-9 w-full" />
          ) : (
            <div className="space-y-3">
              <div className="flex gap-2">
                <PasswordInput
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
                  disabled={regenerateApiKey.isPending}
                  onClick={() => {
                    if (hasKey) {
                      setShowConfirm(true);
                    } else {
                      regenerateApiKey.mutate();
                    }
                  }}
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
        onConfirm={() => {
          regenerateApiKey.mutate();
          setShowConfirm(false);
        }}
      />
    </>
  );
}

const PERCENT = {
  delay: TEXT_INPUT_DELAY,
  transform: (v: number) => Math.max(1, Math.min(100, v)),
};

type ThresholdField = ReturnType<typeof useDebouncedSave<'watchedThresholdMovie'>>;

interface ThresholdFieldConfig {
  id: 'watchedThresholdMovie' | 'watchedThresholdTv' | 'watchedThresholdMusic';
  labelKey: ParseKeys<'settings'>;
  descriptionKey: ParseKeys<'settings'>;
  field: ThresholdField;
}

export function Api() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: settings } = useSettings();

  const movieField = useDebouncedSave(
    'watchedThresholdMovie',
    settings?.watchedThresholdMovie,
    PERCENT
  );
  const tvField = useDebouncedSave('watchedThresholdTv', settings?.watchedThresholdTv, PERCENT);
  const musicField = useDebouncedSave(
    'watchedThresholdMusic',
    settings?.watchedThresholdMusic,
    PERCENT
  );
  const rateLimitField = useDebouncedSave(
    'publicApiRateLimitPerMinute',
    settings?.publicApiRateLimitPerMinute,
    { delay: TEXT_INPUT_DELAY, transform: (v) => Math.max(1, v) }
  );

  const thresholdFields: ThresholdFieldConfig[] = [
    {
      id: 'watchedThresholdMovie',
      labelKey: 'general.watchedThresholdMovie',
      descriptionKey: 'general.watchedThresholdMovieDesc',
      field: movieField,
    },
    {
      id: 'watchedThresholdTv',
      labelKey: 'general.watchedThresholdTv',
      descriptionKey: 'general.watchedThresholdTvDesc',
      field: tvField,
    },
    {
      id: 'watchedThresholdMusic',
      labelKey: 'general.watchedThresholdMusic',
      descriptionKey: 'general.watchedThresholdMusicDesc',
      field: musicField,
    },
  ];

  return (
    <SettingsSection title={t('nav.sections.api')} description={t('nav.descriptions.api')}>
      <ApiKeyCard />

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
            {thresholdFields.map(({ id, labelKey, descriptionKey, field }) => (
              <AutosaveNumberField
                key={id}
                id={id}
                label={t(labelKey)}
                description={t(descriptionKey)}
                value={field.value ?? 85}
                onChange={(v) => {
                  field.setValue(v);
                }}
                min={1}
                max={100}
                suffix={t('general.watchedThresholdSuffix')}
                status={field.status}
                errorMessage={field.errorMessage}
                onRetry={field.retry}
                onReset={field.reset}
              />
            ))}

            <AutosaveNumberField
              id="publicApiRateLimitPerMinute"
              label={t('general.apiRateLimit')}
              description={t('general.apiRateLimitDesc')}
              value={rateLimitField.value ?? 240}
              onChange={(v) => {
                rateLimitField.setValue(v);
              }}
              min={1}
              suffix={t('general.apiRateLimitSuffix')}
              status={rateLimitField.status}
              errorMessage={rateLimitField.errorMessage}
              onRetry={rateLimitField.retry}
              onReset={rateLimitField.reset}
            />
          </FieldGroup>
        </CardContent>
      </Card>
    </SettingsSection>
  );
}
