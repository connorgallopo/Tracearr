import { useTranslation } from 'react-i18next';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { NEWSLETTER_FIELD_IDS, type FieldsetProps } from './newsletterForm';

export function IdentityFields({ state, onChange, errors, mode }: FieldsetProps) {
  const { t } = useTranslation('settings');
  return (
    <FieldGroup className="bg-card-raised gap-5 rounded-xl border p-5">
      <div className="grid items-start gap-4 @md/field-group:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] @md/field-group:gap-x-6">
        <Field data-invalid={errors.name !== undefined}>
          <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.name}>
            {t('newsletters.editor.name')}
          </FieldLabel>
          <Input
            id={NEWSLETTER_FIELD_IDS.name}
            value={state.name}
            maxLength={100}
            aria-invalid={errors.name !== undefined}
            onChange={(event) => onChange({ name: event.target.value })}
          />
          <FieldError>{errors.name}</FieldError>
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.enabled}>
              {mode === 'create' ? t('newsletters.editor.turnOnNow') : t('newsletters.enabled')}
            </FieldLabel>
            <FieldDescription>{t('newsletters.editor.enabledHelp')}</FieldDescription>
          </FieldContent>
          <Switch
            id={NEWSLETTER_FIELD_IDS.enabled}
            checked={state.enabled}
            onCheckedChange={(enabled) => onChange({ enabled })}
          />
        </Field>
      </div>
    </FieldGroup>
  );
}
