import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FieldGroup } from '@/components/ui/field';
import { AutosaveSwitchField } from '@/components/ui/autosave-field';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { useSettings } from '@/hooks/queries';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';

export function Guest() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: settings } = useSettings();
  const allowGuestAccessField = useDebouncedSave('allowGuestAccess', settings?.allowGuestAccess);

  return (
    <SettingsSection title={t('nav.sections.guest')} description={t('nav.descriptions.guest')}>
      <FieldGroup>
        <AutosaveSwitchField
          id="allowGuestAccess"
          label={t('accessControl.allowGuestAccess')}
          description={t('accessControl.allowGuestAccessDesc')}
          checked={false}
          onChange={() => undefined}
          disabled
          status={allowGuestAccessField.status}
          errorMessage={allowGuestAccessField.errorMessage}
          onRetry={allowGuestAccessField.retry}
          onReset={allowGuestAccessField.reset}
        />
      </FieldGroup>

      <Alert>
        <Info />
        <AlertDescription>{t('accessControl.singleOwnerNote')}</AlertDescription>
      </Alert>
    </SettingsSection>
  );
}
