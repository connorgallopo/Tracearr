import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, ExternalLink, Languages } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { AutosaveSelectField } from '@/components/ui/autosave-field';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { useSettings } from '@/hooks/queries';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';
import { changeLanguage, getCurrentLanguage, languageNames } from '@tracearr/translations';
import { getTimeFormat, setTimeFormat, type TimeFormat } from '@/lib/timeFormat';

function LanguageField() {
  const { t } = useTranslation('settings');
  const [language, setLanguage] = useState(getCurrentLanguage);

  return (
    <Field className="max-w-sm">
      <FieldLabel htmlFor="language" className="flex items-center gap-2">
        <Languages className="h-4 w-4" />
        {t('general.language')}
      </FieldLabel>
      <Select
        value={language}
        onValueChange={(lang) => {
          setLanguage(lang);
          void changeLanguage(lang);
        }}
      >
        <SelectTrigger id="language" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(languageNames).map(([code, name]) => (
            <SelectItem key={code} value={code}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>
        {t('general.languageDescription')}{' '}
        <a
          href="https://crowdin.com/project/tracearr"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1"
        >
          {t('general.helpTranslate')}
          <ExternalLink className="h-3 w-3" />
        </a>
      </FieldDescription>
    </Field>
  );
}

function TimeFormatField() {
  const { t } = useTranslation('settings');
  const [timeFormat, setTimeFormatState] = useState<TimeFormat>(getTimeFormat);

  return (
    <Field className="max-w-sm">
      <FieldLabel htmlFor="timeFormat" className="flex items-center gap-2">
        <Clock className="h-4 w-4" />
        {t('general.timeFormat')}
      </FieldLabel>
      <Select
        value={timeFormat}
        onValueChange={(value) => {
          const next = value as TimeFormat;
          setTimeFormatState(next);
          setTimeFormat(next);
        }}
      >
        <SelectTrigger id="timeFormat" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="12h">{t('general.timeFormat12h')}</SelectItem>
          <SelectItem value="24h">{t('general.timeFormat24h')}</SelectItem>
        </SelectContent>
      </Select>
      <FieldDescription>{t('general.timeFormatDescription')}</FieldDescription>
    </Field>
  );
}

export function Locale() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: settings } = useSettings();
  const unitSystemField = useDebouncedSave('unitSystem', settings?.unitSystem);

  return (
    <SettingsSection title={t('nav.sections.locale')} description={t('nav.descriptions.locale')}>
      <FieldGroup>
        <LanguageField />

        <TimeFormatField />

        <AutosaveSelectField
          id="unitSystem"
          label={t('general.unitSystem')}
          description={t('general.unitSystemDesc')}
          value={unitSystemField.value ?? 'metric'}
          onChange={(v) => {
            unitSystemField.setValue(v as 'metric' | 'imperial');
          }}
          options={[
            { value: 'metric', label: t('general.metric') },
            { value: 'imperial', label: t('general.imperial') },
          ]}
          status={unitSystemField.status}
          errorMessage={unitSystemField.errorMessage}
          onRetry={unitSystemField.retry}
          onReset={unitSystemField.reset}
        />
      </FieldGroup>
    </SettingsSection>
  );
}
