import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { needsSenderName, resolveSenderName } from '@tracearr/shared';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useServers } from '@/hooks/queries';
import type { Translate } from '../newsletterFormat';
import { EditorCard } from './EditorCard';
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

/** The tokens stay in code: i18next would interpolate a {{token}} written into a translation value. */
const PLACEHOLDERS = [
  { token: '{{server_name}}', key: 'newsletters.editor.placeholders.server_name' },
  { token: '{{start_date}}', key: 'newsletters.editor.placeholders.start_date' },
  { token: '{{end_date}}', key: 'newsletters.editor.placeholders.end_date' },
  { token: '{{item_count}}', key: 'newsletters.editor.placeholders.item_count' },
] as const;

export function MessageFields({
  state,
  onChange,
  errors,
  touch,
  richTextErrors,
  onRichText,
  fieldKey,
}: FieldsetProps & {
  richTextErrors: RichTextErrors;
  onRichText: RichTextHandler;
  fieldKey: string;
}) {
  const { t } = useTranslation('settings');
  const translate = t as Translate;
  const { data: servers } = useServers();
  const scoped = scopedServers(state.scope, servers ?? []);
  const resolvedSender = resolveSenderName(
    null,
    scoped.map((server) => server.name)
  );
  const nameRequired = needsSenderName(state.senderName, scoped.length);

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
    <EditorCard title={t('newsletters.editor.message')}>
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
          onBlur={() => touch('senderName')}
        />
        {!nameRequired && (
          <FieldDescription>
            {t('newsletters.editor.senderNameHelp', { name: resolvedSender })}
          </FieldDescription>
        )}
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
          onBlur={() => touch('subject')}
        />
        <FieldDescription>{t('newsletters.editor.subjectHelp')}</FieldDescription>
        <ul className="text-muted-foreground flex flex-col gap-1 text-sm">
          {PLACEHOLDERS.map(({ token, key }) => (
            <li key={token}>
              <code className="text-foreground">{token}</code>: {translate(key)}
            </li>
          ))}
        </ul>
        <FieldError>{errors.subject}</FieldError>
      </Field>
      {richText('intro')}
      {richText('outro')}
    </EditorCard>
  );
}
