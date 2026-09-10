import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { DestinationsManager } from '@/components/settings/destinations';
import { useAuth } from '@/hooks/useAuth';

export function Destinations() {
  const { t } = useTranslation(['settings', 'pages']);
  const { user } = useAuth();

  return (
    <SettingsSection
      title={t('settings:nav.sections.destinations')}
      description={t('settings:nav.descriptions.destinations')}
    >
      {user?.role === 'owner' ? (
        <DestinationsManager />
      ) : (
        <Alert>
          <Info />
          <AlertDescription>{t('pages:settings.destinations.ownerOnly')}</AlertDescription>
        </Alert>
      )}
    </SettingsSection>
  );
}
