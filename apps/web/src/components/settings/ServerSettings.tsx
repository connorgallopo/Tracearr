import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Image as ImageIcon } from 'lucide-react';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';
import { AutosaveSelectField } from '@/components/ui/autosave-field';
import type { Server } from '@tracearr/shared';
import { useSettings } from '@/hooks/queries';

const AUTOMATIC_POSTER_SOURCE = 'auto';

/**
 * Poster source preference: which server's poster wins when the same title
 * exists on more than one server. "Automatic" (null server id) keeps
 * today's behavior of using the most recently added copy.
 */
export function PosterSourceCard({ servers, isOwner }: { servers: Server[]; isOwner: boolean }) {
  const { t } = useTranslation(['settings']);
  const { data: settings, isLoading: isLoadingSettings } = useSettings();
  const preferredPosterField = useDebouncedSave(
    'preferredPosterServerId',
    settings?.preferredPosterServerId
  );

  if (!isOwner) return null;

  const hasServers = servers.length > 0;
  const selectValue = preferredPosterField.value || AUTOMATIC_POSTER_SOURCE;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ImageIcon className="h-5 w-5" />
          {t('servers.posterSource.title')}
        </CardTitle>
        <CardDescription>{t('servers.posterSource.titleDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoadingSettings ? (
          <Skeleton className="h-9 w-full max-w-sm" />
        ) : (
          <AutosaveSelectField
            id="preferredPosterServerId"
            label={t('servers.posterSource.label')}
            description={
              hasServers
                ? t('servers.posterSource.description')
                : t('servers.posterSource.emptyHint')
            }
            value={selectValue}
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
      </CardContent>
    </Card>
  );
}
