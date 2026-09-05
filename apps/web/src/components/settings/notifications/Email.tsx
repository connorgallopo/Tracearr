import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { useAuth } from '@/hooks/useAuth';
import { BrandingForm } from './BrandingForm';
import { Suppressions } from './Suppressions';

export function Email() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();

  return (
    <SettingsSection title={t('nav.sections.email')} description={t('nav.descriptions.email')}>
      {user?.role === 'owner' ? (
        <>
          <BrandingForm />
          <Suppressions />
        </>
      ) : (
        <Alert>
          <Info />
          <AlertDescription>{t('email.ownerOnly')}</AlertDescription>
        </Alert>
      )}
    </SettingsSection>
  );
}
