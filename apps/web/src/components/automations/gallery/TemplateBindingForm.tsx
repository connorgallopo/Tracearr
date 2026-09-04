import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AUTOMATION_NAME_MAX, type TemplateInput } from '@tracearr/shared';
import { BindingDoors } from '@/components/ui/form-doors';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { useServer } from '@/hooks/useServer';
import { templateDraft, templateName, type AutomationDraft } from '@/lib/automations';
import { cn } from '@/lib/utils';
import type { AutomationTemplate } from '@/lib/api';
import { TemplateEffects } from './TemplateEffects';
import { TemplateInputRows, TemplateSentencePanel, useTemplateAnswers } from './TemplateInputs';

/** What the primary door is handed once every required answer is in. */
export interface TemplateBindingSubmission {
  inputs: Record<string, unknown>;
  name: string;
  isActive: boolean;
}

/** The two ways out, worded and wired by whoever is showing the form. */
export interface TemplateBindingDoors {
  primaryLabel: string;
  primaryIcon?: ReactNode;
  onPrimary: (submission: TemplateBindingSubmission) => void;
  pending: boolean;
  /** Left out where the only way on is Save, which is what an unbound row has. */
  secondaryLabel?: string;
  /** The draft is the answers as an automation; a row that already exists ignores it. */
  onSecondary?: (draft: AutomationDraft) => void;
  helper?: string;
  /** What the left of the doors row says, which is whether anything is unsaved. */
  status?: ReactNode;
  /** Off until something is worth sending; the dialog leaves it on. */
  disabled?: boolean;
}

interface TemplateBindingFormProps {
  template: AutomationTemplate;
  doors: TemplateBindingDoors;
  /** The answers a bound row already carries; a new one opens on the defaults. */
  initialValues?: Record<string, unknown> | null;
  /** The page header owns the name and the switch once the automation exists. */
  showInstanceFields?: boolean;
  /** Names the sentence panel when an upgrade puts the old one beside it. */
  sentenceLabel?: string;
  /**
   * What a row that already exists is called, handed the sentence panel to place under
   * itself. Never passed with the dialog's own name field.
   */
  identity?: (sentence: ReactNode) => ReactNode;
  /** The row's own limits, laid out on the same tracks as the answers beside them. */
  instanceFields?: ReactNode;
  /** Told the first time an answer changes, so one Save can send only what moved. */
  onAnswerEdited?: () => void;
  bodyClassName?: string;
  /** Lands on the child of the answers' field group, which is where the grid belongs. */
  fieldsClassName?: string;
  /** The dialog keeps its labels above the controls; the detail page puts them left. */
  rowOrientation?: 'vertical' | 'responsive';
  footerClassName?: string;
}

/** What it does, what it needs, what it will do, then the two doors. */
export function TemplateBindingForm({
  template,
  doors,
  initialValues,
  showInstanceFields = true,
  sentenceLabel,
  identity,
  instanceFields,
  onAnswerEdited,
  bodyClassName,
  fieldsClassName,
  rowOrientation,
  footerClassName,
}: TemplateBindingFormProps) {
  const { t } = useTranslation('pages');
  const { servers } = useServer();

  const { version } = template;
  const answers = useTemplateAnswers(version, initialValues);
  const [name, setName] = useState(() => templateName(t, template));

  const [nameDirty, setNameDirty] = useState(false);
  const [isActive, setIsActive] = useState(true);

  const { refs, fragments, serverKey, boundServerId } = answers;

  /** What the name reads as until it is edited, and what an emptied field falls back to. */
  const defaultName = (serverId: string) => {
    const base = templateName(t, template);
    const server = servers.find((entry) => entry.id === serverId);
    return (server ? `${base} — ${server.name}` : base).slice(0, AUTOMATION_NAME_MAX);
  };

  const setValue = (input: TemplateInput, value: unknown) => {
    answers.setValue(input, value);
    onAnswerEdited?.();
    if (input.kind !== 'server' || nameDirty) return;
    setName(defaultName(typeof value === 'string' ? value : ''));
  };

  const submission = (): TemplateBindingSubmission => ({
    inputs: answers.bound(),
    name: name.trim() || defaultName(boundServerId),
    isActive,
  });

  const submit = () => {
    if (!answers.attemptSubmit()) return;
    doors.onPrimary(submission());
  };

  const customize = () => {
    const { inputs, ...rest } = submission();
    doors.onSecondary?.(templateDraft(version, inputs, rest));
  };

  const sentencePanel = (
    <TemplateSentencePanel
      fragments={fragments}
      label={sentenceLabel}
      highlightKey={answers.focused}
    />
  );

  return (
    <>
      <div className={cn('flex flex-col gap-7', bodyClassName)}>
        {identity === undefined ? sentencePanel : identity(sentencePanel)}

        {version.inputs.length === 0 && (
          <p className="text-muted-foreground text-sm">{t('automations.bind.noInputs')}</p>
        )}

        {(version.inputs.length > 0 || instanceFields !== undefined) && (
          <FieldGroup className="gap-6">
            {version.inputs.length > 0 && (
              <section
                aria-label={t('automations.bind.needs.title')}
                className={cn('flex flex-col gap-5', fieldsClassName)}
              >
                <TemplateInputRows
                  version={version}
                  values={answers.values}
                  onChange={setValue}
                  boundServerId={boundServerId}
                  submitted={answers.submitted}
                  orientation={rowOrientation}
                  onFocusInput={answers.setFocused}
                />
              </section>
            )}
            {instanceFields}
          </FieldGroup>
        )}

        <TemplateEffects
          definition={version.definition}
          hasServerInput={serverKey !== undefined}
          serverName={refs.servers?.[boundServerId]}
        />

        {showInstanceFields && (
          <>
            <Separator />
            <Field>
              <FieldLabel htmlFor="template-name">{t('automations.name')}</FieldLabel>
              <Input
                id="template-name"
                value={name}
                maxLength={AUTOMATION_NAME_MAX}
                placeholder={t('automations.bind.namePlaceholder')}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameDirty(true);
                }}
                onBlur={() => {
                  if (name.trim() !== '') return;
                  setName(defaultName(boundServerId));
                  setNameDirty(false);
                }}
              />
              <FieldDescription>{t('automations.bind.nameHelper')}</FieldDescription>
            </Field>
          </>
        )}
      </div>

      <BindingDoors
        {...doors}
        className={footerClassName}
        onPrimary={submit}
        onSecondary={doors.secondaryLabel === undefined ? undefined : customize}
        leading={
          showInstanceFields && (
            <div className="flex items-center gap-2">
              <Switch id="template-active" checked={isActive} onCheckedChange={setIsActive} />
              <FieldLabel htmlFor="template-active">{t('automations.bind.activeLabel')}</FieldLabel>
            </div>
          )
        }
      />
    </>
  );
}
