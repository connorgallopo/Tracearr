import { useTranslation } from 'react-i18next';
import { SERVER_PROFILES, SERVER_TYPES, isServerType, type ServerType } from '@tracearr/shared';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { Field, FieldLabel, FieldTitle } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { SetupLayout } from './SetupLayout';
import type { SetupStep } from './SetupSteps';

export function ServerTypePicker({
  value,
  onChange,
  label,
}: {
  value: ServerType | null;
  onChange: (type: ServerType) => void;
  label: string;
}) {
  return (
    <RadioGroup
      value={value ?? ''}
      onValueChange={(next) => {
        if (isServerType(next)) onChange(next);
      }}
      aria-label={label}
      className="sm:grid-cols-2"
    >
      {SERVER_TYPES.map((type) => (
        <FieldLabel key={type} htmlFor={`server-type-${type}`} className="cursor-pointer">
          <Field orientation="horizontal" className="gap-3">
            <MediaServerIcon type={type} alt="" className="size-8 shrink-0" />
            <FieldTitle className="flex-1 text-base">
              {SERVER_PROFILES[type].displayName}
            </FieldTitle>
            <RadioGroupItem value={type} id={`server-type-${type}`} />
          </Field>
        </FieldLabel>
      ))}
    </RadioGroup>
  );
}

/** Step 1, shared by the first run and by an owner changing the type before connecting. */
export function ServerTypeStep({
  steps,
  value,
  onChange,
  onContinue,
}: {
  steps: SetupStep[];
  value: ServerType | null;
  onChange: (type: ServerType) => void;
  onContinue: () => void;
}) {
  const { t } = useTranslation(['pages', 'common']);

  return (
    <SetupLayout
      steps={steps}
      title={t('pages:setup.serverTitle')}
      description={t('pages:setup.serverHint')}
      actions={
        <Button disabled={!value} onClick={onContinue}>
          {t('common:actions.continue')}
        </Button>
      }
    >
      <ServerTypePicker value={value} onChange={onChange} label={t('pages:setup.serverTitle')} />
    </SetupLayout>
  );
}
