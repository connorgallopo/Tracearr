import { useTranslation } from 'react-i18next';
import { AUTOMATION_DESCRIPTION_MAX, AUTOMATION_NAME_MAX } from '@tracearr/shared';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { ReactNode } from 'react';

interface AutomationIdentityFieldsProps {
  name: string;
  onNameChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  /** The builder jumps to a faulted control by id, so both ids come from the caller. */
  nameId: string;
  descriptionId: string;
  nameInvalid?: boolean;
  descriptionInvalid?: boolean;
  /** Whatever the caller puts under a control it has faulted. */
  nameError?: ReactNode;
  descriptionError?: ReactNode;
  /** What sits under the fields on the same raised card: the sentence, and what follows it. */
  children?: ReactNode;
}

/**
 * What the automation is called and what it is for, wherever the two are edited, on the
 * raised card they share with the sentence. A name is a label and a description is a
 * sentence, so they take unequal columns.
 */
export function AutomationIdentityFields({
  name,
  onNameChange,
  description,
  onDescriptionChange,
  nameId,
  descriptionId,
  nameInvalid,
  descriptionInvalid,
  nameError,
  descriptionError,
  children,
}: AutomationIdentityFieldsProps) {
  const { t } = useTranslation('pages');

  return (
    <FieldGroup className="bg-card dark:bg-card-raised gap-5 rounded-xl border p-5">
      <div className="grid items-start gap-4 @md/field-group:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] @md/field-group:gap-x-6">
        <Field>
          <FieldLabel htmlFor={nameId}>{t('automations.name')}</FieldLabel>
          <Input
            id={nameId}
            value={name}
            maxLength={AUTOMATION_NAME_MAX}
            placeholder={t('automations.namePlaceholder')}
            aria-invalid={nameInvalid}
            onChange={(event) => onNameChange(event.target.value)}
          />
          {nameError}
        </Field>

        <Field>
          <FieldLabel htmlFor={descriptionId}>{t('automations.descriptionLabel')}</FieldLabel>
          <Textarea
            id={descriptionId}
            rows={2}
            value={description}
            maxLength={AUTOMATION_DESCRIPTION_MAX}
            placeholder={t('automations.descriptionPlaceholder')}
            aria-invalid={descriptionInvalid}
            onChange={(event) => onDescriptionChange(event.target.value)}
          />
          {descriptionError}
        </Field>
      </div>

      {children}
    </FieldGroup>
  );
}
