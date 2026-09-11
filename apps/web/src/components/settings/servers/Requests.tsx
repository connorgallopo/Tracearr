import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { RequestServicesManager } from '@/components/settings/request-services';
import { useAuth } from '@/hooks/useAuth';

export function Requests() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();

  return (
    <SettingsSection
      title={t('nav.sections.requests')}
      description={t('nav.descriptions.requests')}
    >
      {user?.role === 'owner' ? (
        <RequestServicesManager />
      ) : (
        <Alert>
          <Info />
          <AlertDescription>{t('requests.ownerOnly')}</AlertDescription>
        </Alert>
      )}
    </SettingsSection>
  );
}
