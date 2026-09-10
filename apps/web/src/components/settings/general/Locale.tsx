import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, ExternalLink, Languages, type LucideIcon } from 'lucide-react';
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

function LocaleSelect({
  id,
  icon: Icon,
  label,
  description,
  value,
  onChange,
  options,
}: {
  id: string;
  icon: LucideIcon;
  label: string;
  description: ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Field className="max-w-sm">
      <FieldLabel htmlFor={id} className="flex items-center gap-2">
        <Icon className="h-4 w-4" />
        {label}
      </FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}

export function Locale() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: settings } = useSettings();
  const [language, setLanguage] = useState(getCurrentLanguage);
  const [timeFormat, setTimeFormatState] = useState<TimeFormat>(getTimeFormat);
  const unitSystemField = useDebouncedSave('unitSystem', settings?.unitSystem);

  return (
    <SettingsSection title={t('nav.sections.locale')} description={t('nav.descriptions.locale')}>
      <FieldGroup>
        <LocaleSelect
          id="language"
          icon={Languages}
          label={t('general.language')}
          description={
            <>
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
            </>
          }
          value={language}
          onChange={(lang) => {
            setLanguage(lang);
            void changeLanguage(lang);
          }}
          options={Object.entries(languageNames).map(([code, name]) => ({
            value: code,
            label: name,
          }))}
        />

        <LocaleSelect
          id="timeFormat"
          icon={Clock}
          label={t('general.timeFormat')}
          description={t('general.timeFormatDescription')}
          value={timeFormat}
          onChange={(value) => {
            const next = value as TimeFormat;
            setTimeFormatState(next);
            setTimeFormat(next);
          }}
          options={[
            { value: '12h', label: t('general.timeFormat12h') },
            { value: '24h', label: t('general.timeFormat24h') },
          ]}
        />

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
