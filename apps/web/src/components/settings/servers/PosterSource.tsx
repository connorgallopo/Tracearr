import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import type { Server } from '@tracearr/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { AutosaveSelectField } from '@/components/ui/autosave-field';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { useServers, useSettings } from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';

const AUTOMATIC_POSTER_SOURCE = 'auto';

/** A null server id keeps using the most recently added copy of a title. */
export function PosterSource() {
  const { t } = useTranslation(['settings']);
  const { user } = useAuth();
  const { data: serversData } = useServers();
  const { data: settings, isLoading: isLoadingSettings } = useSettings();
  const preferredPosterField = useDebouncedSave(
    'preferredPosterServerId',
    settings?.preferredPosterServerId
  );

  const servers = Array.isArray(serversData)
    ? serversData
    : ((serversData as unknown as { data?: Server[] })?.data ?? []);
  const hasServers = servers.length > 0;

  return (
    <SettingsSection title={t('nav.sections.posters')} description={t('nav.descriptions.posters')}>
      {user?.role !== 'owner' ? (
        <Alert>
          <Info />
          <AlertDescription>{t('servers.posterSource.ownerOnly')}</AlertDescription>
        </Alert>
      ) : isLoadingSettings ? (
        <Skeleton className="h-9 w-full max-w-sm" />
      ) : (
        <AutosaveSelectField
          id="preferredPosterServerId"
          label={t('servers.posterSource.label')}
          description={
            hasServers ? t('servers.posterSource.description') : t('servers.posterSource.emptyHint')
          }
          value={preferredPosterField.value || AUTOMATIC_POSTER_SOURCE}
          onChange={(v) => {
            preferredPosterField.setValue(v === AUTOMATIC_POSTER_SOURCE ? null : v);
          }}
          options={[
            { value: AUTOMATIC_POSTER_SOURCE, label: t('servers.posterSource.automatic') },
            ...servers.map((server) => ({ value: server.id, label: server.name })),
          ]}
          disabled={!hasServers}
          status={preferredPosterField.status}
          errorMessage={preferredPosterField.errorMessage}
          onRetry={preferredPosterField.retry}
          onReset={preferredPosterField.reset}
        />
      )}
    </SettingsSection>
  );
}
