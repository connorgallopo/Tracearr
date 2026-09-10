import { useTranslation } from 'react-i18next';
import { ArrowUpCircle } from 'lucide-react';
import { AutosaveSwitchField } from '@/components/ui/autosave-field';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { useSettings } from '@/hooks/queries';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';

/**
 * The two background update checks. Both are plain settings toggles; what they nudge
 * about is delivered by whatever automation listens for the update triggers.
 */
export function UpdateChecksCard() {
  const { t } = useTranslation('settings');
  const { data: settings } = useSettings();
  const pluginField = useDebouncedSave(
    'pluginUpdateCheckEnabled',
    settings?.pluginUpdateCheckEnabled
  );
  const serverField = useDebouncedSave(
    'serverUpdateCheckEnabled',
    settings?.serverUpdateCheckEnabled
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowUpCircle className="h-5 w-5" />
          {t('general.updateChecks.title')}
        </CardTitle>
        <CardDescription>{t('general.updateChecks.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <AutosaveSwitchField
            id="pluginUpdateCheckEnabled"
            label={t('general.updateChecks.plugin')}
            description={t('general.updateChecks.pluginDesc')}
            checked={pluginField.value ?? true}
            onChange={(v) => pluginField.setValue(v)}
            status={pluginField.status}
            errorMessage={pluginField.errorMessage}
            onRetry={pluginField.retry}
            onReset={pluginField.reset}
          />

          <AutosaveSwitchField
            id="serverUpdateCheckEnabled"
            label={t('general.updateChecks.server')}
            description={t('general.updateChecks.serverDesc')}
            checked={serverField.value ?? true}
            onChange={(v) => serverField.setValue(v)}
            status={serverField.status}
            errorMessage={serverField.errorMessage}
            onRetry={serverField.retry}
            onReset={serverField.reset}
          />
        </FieldGroup>
      </CardContent>
    </Card>
  );
}
