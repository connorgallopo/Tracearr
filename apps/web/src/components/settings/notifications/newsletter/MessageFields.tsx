import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveSenderName } from '@tracearr/shared';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useServers } from '@/hooks/queries';
import {
  NEWSLETTER_FIELD_IDS,
  scopedServers,
  type FieldsetProps,
  type RichTextErrors,
  type RichTextHandler,
} from './newsletterForm';

/** Tiptap stays out of the main chunk; it loads with the editor page, not with Settings. */
const RichTextField = lazy(() =>
  import('@/components/ui/rich-text-field').then((m) => ({ default: m.RichTextField }))
);

const PLACEHOLDERS = ['{{server_name}}', '{{start_date}}', '{{end_date}}', '{{item_count}}'];

export function MessageFields({
  state,
  onChange,
  errors,
  richTextErrors,
  onRichText,
  fieldKey,
}: FieldsetProps & {
  richTextErrors: RichTextErrors;
  onRichText: RichTextHandler;
  fieldKey: string;
}) {
  const { t } = useTranslation('settings');
  const { data: servers } = useServers();
  const scoped = scopedServers(state.scope, servers ?? []);
  const resolvedSender = resolveSenderName(
    null,
    scoped.map((server) => server.name)
  );

  const richText = (field: 'intro' | 'outro') => (
    <Field data-invalid={richTextErrors[field] !== undefined}>
      <FieldLabel id={`${NEWSLETTER_FIELD_IDS[field]}-label`}>
        {t(`newsletters.editor.${field}`)}
      </FieldLabel>
      <Suspense fallback={<Skeleton className="h-32 w-full" />}>
        <RichTextField
          key={`${fieldKey}-${field}`}
          id={NEWSLETTER_FIELD_IDS[field]}
          labelledBy={`${NEWSLETTER_FIELD_IDS[field]}-label`}
          value={state[field]}
          placeholder={t(`newsletters.editor.${field}Placeholder`)}
          onChange={(change) => onRichText(field, change)}
        />
      </Suspense>
      <FieldError>{richTextErrors[field]}</FieldError>
    </Field>
  );

  return (
    <FieldSet>
      <FieldLegend>{t('newsletters.editor.message')}</FieldLegend>
      <Field className="max-w-sm" data-invalid={errors.senderName !== undefined}>
        <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.senderName}>
          {t('newsletters.editor.senderName')}
        </FieldLabel>
        <Input
          id={NEWSLETTER_FIELD_IDS.senderName}
          value={state.senderName ?? ''}
          placeholder={resolvedSender}
          maxLength={100}
          aria-invalid={errors.senderName !== undefined}
          onChange={(event) =>
            onChange({ senderName: event.target.value === '' ? null : event.target.value })
          }
        />
        <FieldDescription>
          {t('newsletters.editor.senderNameHelp', { name: resolvedSender })}
        </FieldDescription>
        <FieldError>{errors.senderName}</FieldError>
      </Field>
      <Field data-invalid={errors.subject !== undefined}>
        <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.subject}>
          {t('newsletters.editor.subject')}
        </FieldLabel>
        <Input
          id={NEWSLETTER_FIELD_IDS.subject}
          value={state.subject}
          maxLength={200}
          aria-invalid={errors.subject !== undefined}
          onChange={(event) => onChange({ subject: event.target.value })}
        />
        <FieldDescription>
          {t('newsletters.editor.subjectHelp')} {PLACEHOLDERS.join(', ')}
        </FieldDescription>
        <FieldError>{errors.subject}</FieldError>
      </Field>
      {richText('intro')}
      {richText('outro')}
    </FieldSet>
  );
}
