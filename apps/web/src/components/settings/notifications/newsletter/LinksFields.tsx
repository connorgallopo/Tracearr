import { useTranslation } from 'react-i18next';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { NEWSLETTER_FIELD_IDS, type FieldsetProps } from './newsletterForm';

export function LinksFields({ state, onChange }: FieldsetProps) {
  const { t } = useTranslation('settings');
  return (
    <FieldSet>
      <FieldLegend>{t('newsletters.editor.links.title')}</FieldLegend>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.linksTracearr}>
            {t('newsletters.editor.links.tracearr')}
          </FieldLabel>
          <FieldDescription>{t('newsletters.editor.links.tracearrNote')}</FieldDescription>
        </FieldContent>
        <Switch
          id={NEWSLETTER_FIELD_IDS.linksTracearr}
          checked={state.links.tracearr}
          onCheckedChange={(tracearr) => onChange({ links: { tracearr } })}
          aria-label={t('newsletters.editor.links.tracearr')}
        />
      </Field>
    </FieldSet>
  );
}
