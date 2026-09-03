import { useTranslation } from 'react-i18next';
import { Settings as SettingsIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { AutosaveNumberField, AutosaveSwitchField } from '@/components/ui/autosave-field';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { UpdateChecksCard } from '@/components/settings/general/UpdateChecksCard';
import { ImageCacheCard } from '@/components/settings/general/ImageCacheCard';
import { useSettings } from '@/hooks/queries';
import { TEXT_INPUT_DELAY, useDebouncedSave } from '@/hooks/useDebouncedSave';

export function Behavior() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: settings } = useSettings();

  const pollerEnabledField = useDebouncedSave('pollerEnabled', settings?.pollerEnabled);
  const pollerIntervalField = useDebouncedSave('pollerIntervalMs', settings?.pollerIntervalMs, {
    delay: TEXT_INPUT_DELAY,
    transform: (ms) => Math.max(5000, Math.min(300000, ms)),
  });
  const usePlexGeoipField = useDebouncedSave('usePlexGeoip', settings?.usePlexGeoip);

  const pollerEnabled = pollerEnabledField.value ?? true;
  const intervalSeconds = Math.round((pollerIntervalField.value ?? 15000) / 1000);

  return (
    <SettingsSection
      title={t('nav.sections.behavior')}
      description={t('nav.descriptions.behavior')}
    >
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
              checked={pollerEnabled}
              onChange={(v) => {
                pollerEnabledField.setValue(v);
              }}
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
              onChange={(seconds) => {
                pollerIntervalField.setValue(seconds * 1000);
              }}
              min={5}
              max={300}
              suffix={t('general.syncIntervalSuffix')}
              disabled={!pollerEnabled}
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
              onChange={(v) => {
                usePlexGeoipField.setValue(v);
              }}
              status={usePlexGeoipField.status}
              errorMessage={usePlexGeoipField.errorMessage}
              onRetry={usePlexGeoipField.retry}
              onReset={usePlexGeoipField.reset}
            />
          </FieldGroup>
        </CardContent>
      </Card>

      <UpdateChecksCard />

      <ImageCacheCard />
    </SettingsSection>
  );
}
