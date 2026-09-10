import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowUpCircle, Loader2, Save } from 'lucide-react';
import {
  RETENTION_DEFAULTS,
  type Automation,
  type AutomationTemplateRef,
  type TemplateDefinition,
  type ViolationSeverity,
} from '@tracearr/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Field,
  FieldContent,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import {
  INPUT_GROUP_UNIT,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { AutomationIdentityFields } from '@/components/automations/AutomationIdentityFields';
import { BindingDoors } from '@/components/ui/form-doors';
import { TemplateBindingForm } from '@/components/automations/gallery/TemplateBindingForm';
import { TemplateEffects } from '@/components/automations/gallery/TemplateEffects';
import {
  AutomationSentencePanel,
  TemplateSentencePanel,
  useTemplateBinding,
} from '@/components/automations/gallery/TemplateInputs';
import {
  useDetachAutomation,
  useRebindAutomation,
  useTemplate,
  useTemplateVersion,
  useUpdateAutomation,
  useUpgradeAutomation,
} from '@/hooks/queries';
import { readOverride, SEVERITIES, severityLabel } from '@/lib/automations';

/**
 * Both groups state the same tracks, so the legend between them reflows nothing. Two-up
 * waits a step past the label-left flip: at 28 rem a 16 px gutter leaves a squeezed label.
 */
const ANSWER_GROUP =
  '@xl/field-group:grid-cols-2 grid gap-x-16 gap-y-6 [&>[data-wide]]:col-span-full';

/** It rides the answers and comes to rest at the rule above Activity, which it cannot save. */
const DOORS = 'bg-background/95 sticky bottom-0 z-10 -mb-3 border-t pt-4 pb-3 backdrop-blur';

const BODY = 'mt-7 flex flex-col gap-7';

/** `Field` sets its children's width itself, so a row's control is sized by its bounds. */
const CONTROL = '@md/field-group:max-w-44 @md/field-group:min-w-44';

interface AutomationDetailFormProps {
  automation: Automation;
  /** Null for a row that owns its own steps: the blanks section is the only difference. */
  template: AutomationTemplateRef | null;
}

/** The one form on a row's page: what it is called, what it answers, and one Save. */
export function AutomationDetailForm({ automation, template }: AutomationDetailFormProps) {
  const { t } = useTranslation(['pages', 'common']);
  const navigate = useNavigate();
  const updateAutomation = useUpdateAutomation();
  const rebindAutomation = useRebindAutomation();
  const upgradeAutomation = useUpgradeAutomation();
  const detachAutomation = useDetachAutomation();

  const { data: catalogEntry, isLoading } = useTemplate(template?.id);

  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [answersDirty, setAnswersDirty] = useState(false);
  const [ownDirty, setOwnDirty] = useState(false);
  const [name, setName] = useState(automation.name);
  const [description, setDescription] = useState(automation.description ?? '');
  const [severity, setSeverity] = useState<ViolationSeverity>(automation.severity ?? 'warning');
  const [cooldownMinutes, setCooldownMinutes] = useState(String(automation.cooldownMinutes ?? ''));
  const [retentionDays, setRetentionDays] = useState(String(automation.retentionDays ?? ''));

  // Only an upgrade needs the old version, and only to say what the row does today.
  const outdated =
    template !== null && template.version < template.currentVersion ? template : null;
  const { data: pinned } = useTemplateVersion(outdated?.id, outdated?.version);
  const { fragments: pinnedFragments } = useTemplateBinding(
    pinned,
    automation.templateInputs ?? {}
  );

  const cooldown = readOverride(cooldownMinutes, 0);
  const retention = readOverride(retentionDays, 1);
  const nameInvalid = name.trim() === '';
  const invalid = nameInvalid || cooldown.invalid || retention.invalid;

  const pending =
    updateAutomation.isPending || rebindAutomation.isPending || upgradeAutomation.isPending;
  const dirty = ownDirty || answersDirty;

  /**
   * The row's own fields go first, so a name the API refuses never lands beside saved
   * answers; whichever call runs last is the one that says the save landed.
   */
  const save = async (inputs: Record<string, unknown> | null) => {
    if (invalid || pending) return;
    const answers = inputs !== null && (answersDirty || outdated !== null) ? inputs : null;
    if (!ownDirty && answers === null) return;

    try {
      if (ownDirty) {
        await updateAutomation.mutateAsync({
          id: automation.id,
          silent: answers !== null,
          data: {
            name: name.trim(),
            description: description.trim() === '' ? null : description.trim(),
            ...(automation.kind === 'policy' ? { severity } : {}),
            cooldownMinutes: cooldown.value,
            retentionDays: retention.value,
          },
        });
      }
      setOwnDirty(false);

      if (answers !== null) {
        if (outdated !== null) {
          await upgradeAutomation.mutateAsync({ id: automation.id, inputs: answers });
        } else {
          await rebindAutomation.mutateAsync({ id: automation.id, inputs: answers });
        }
      }
      setAnswersDirty(false);
    } catch {
      // The mutation hook has toasted; whatever has not landed stays in the form, dirty.
    }
  };

  const detach = () => {
    detachAutomation.mutate(automation.id, {
      onSuccess: () => {
        setCustomizeOpen(false);
        void navigate(`/automations/${automation.id}/edit`);
      },
    });
  };

  const identity = (sentence: ReactNode) => (
    <AutomationIdentityFields
      name={name}
      onNameChange={(value) => {
        setName(value);
        setOwnDirty(true);
      }}
      description={description}
      onDescriptionChange={(value) => {
        setDescription(value);
        setOwnDirty(true);
      }}
      nameId="automation-name"
      descriptionId="automation-description"
      nameInvalid={nameInvalid}
      nameError={nameInvalid ? <FieldError>{t('pages:automations.nameInvalid')}</FieldError> : null}
    >
      {sentence}
    </AutomationIdentityFields>
  );

  const instanceFields = (
    <FieldSet>
      <FieldLegend
        variant="label"
        className="after:bg-border flex w-full items-center gap-3 after:h-px after:flex-1 after:content-['']"
      >
        {t('pages:automations.thisAutomation')}
      </FieldLegend>

      <div className={ANSWER_GROUP}>
        <OverrideRow
          id="automation-cooldown"
          label={t('pages:automations.cooldownLabel')}
          unit={t('pages:automations.units.minutes')}
          value={cooldownMinutes}
          invalid={cooldown.invalid}
          error={t('pages:automations.cooldownInvalid')}
          onChange={(value) => {
            setCooldownMinutes(value);
            setOwnDirty(true);
          }}
        />

        {automation.kind === 'policy' && (
          <Field orientation="responsive">
            <FieldLabel htmlFor="automation-severity">{t('common:labels.severity')}</FieldLabel>
            <Select
              value={severity}
              onValueChange={(value) => {
                setSeverity(value as ViolationSeverity);
                setOwnDirty(true);
              }}
            >
              <SelectTrigger id="automation-severity" className={CONTROL}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {severityLabel(t, option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

        <OverrideRow
          id="automation-retention"
          label={t('pages:automations.retentionLabel')}
          unit={t('pages:automations.units.days')}
          placeholder={t('pages:automations.retentionPlaceholder', {
            days: RETENTION_DEFAULTS[automation.kind],
          })}
          value={retentionDays}
          invalid={retention.invalid}
          error={t('pages:automations.retentionInvalid')}
          onChange={(value) => {
            setRetentionDays(value);
            setOwnDirty(true);
          }}
        />
      </div>
    </FieldSet>
  );

  const status = dirty ? (
    <span className="text-muted-foreground flex items-center gap-2 text-sm">
      <span className="bg-primary size-1.5 rounded-full" />
      {t('pages:automations.detail.unsaved')}
    </span>
  ) : null;

  const saveLabel = pending
    ? t('pages:automations.builder.saving')
    : t('pages:automations.template.save');
  const saveIcon = pending ? <Loader2 className="animate-spin" /> : <Save />;

  if (template !== null && isLoading) return <Skeleton className="mt-7 h-64 w-full" />;

  // No blanks to fill: a row that owns its steps, or one whose template is gone.
  if (template === null || catalogEntry === undefined) {
    return (
      <form className={BODY}>
        {template !== null && (
          <p className="text-muted-foreground text-sm">{t('pages:automations.template.gone')}</p>
        )}

        {identity(<AutomationSentencePanel automation={automation} />)}

        <FieldGroup className="gap-6">{instanceFields}</FieldGroup>

        <TemplateEffects definition={ownDefinition(automation)} hasServerInput={false} />

        <BindingDoors
          className={DOORS}
          primaryLabel={saveLabel}
          primaryIcon={saveIcon}
          pending={pending}
          disabled={invalid || !dirty}
          status={status}
          onPrimary={() => void save(null)}
        />
      </form>
    );
  }

  return (
    <form className={BODY}>
      {outdated !== null && (
        <Alert>
          <ArrowUpCircle />
          <AlertTitle>
            {t('pages:automations.template.updatedTitle', { version: outdated.currentVersion })}
          </AlertTitle>
          <AlertDescription>{t('pages:automations.template.updatedBody')}</AlertDescription>
        </Alert>
      )}

      {outdated !== null && pinned && (
        <TemplateSentencePanel
          fragments={pinnedFragments}
          label={t('pages:automations.template.before')}
        />
      )}

      <TemplateBindingForm
        key={catalogEntry.version.version}
        template={catalogEntry}
        initialValues={automation.templateInputs}
        showInstanceFields={false}
        sentenceLabel={outdated !== null ? t('pages:automations.template.after') : undefined}
        identity={identity}
        instanceFields={instanceFields}
        fieldsClassName={ANSWER_GROUP}
        rowOrientation="responsive"
        footerClassName={DOORS}
        onAnswerEdited={() => setAnswersDirty(true)}
        doors={{
          primaryLabel:
            outdated !== null && !pending ? t('pages:automations.template.review') : saveLabel,
          primaryIcon: outdated !== null && !pending ? <ArrowUpCircle /> : saveIcon,
          pending,
          // An update is worth sending on its own: the version moved, not the answers.
          disabled: invalid || (!dirty && outdated === null),
          status,
          onPrimary: ({ inputs }) => void save(inputs),
          secondaryLabel: t('pages:automations.template.customize'),
          onSecondary: () => setCustomizeOpen(true),
          helper: t('pages:automations.template.doorsHelper'),
        }}
      />

      <ConfirmDialog
        open={customizeOpen}
        onOpenChange={setCustomizeOpen}
        title={t('pages:automations.template.customizeTitle')}
        description={t('pages:automations.template.customizeConfirm')}
        confirmLabel={t('pages:automations.template.customizeConfirmAction')}
        onConfirm={detach}
        isLoading={detachAutomation.isPending}
      />
    </form>
  );
}

interface OverrideRowProps {
  id: string;
  label: string;
  unit: string;
  /** The default, shown in place of a hint line so every row stays one line tall. */
  placeholder?: string;
  value: string;
  invalid: boolean;
  error: string;
  onChange: (value: string) => void;
}

/** An optional whole number with its unit in the control, so the label completes into it. */
function OverrideRow({
  id,
  label,
  unit,
  placeholder,
  value,
  invalid,
  error,
  onChange,
}: OverrideRowProps): ReactNode {
  return (
    <Field orientation="responsive" data-invalid={invalid || undefined}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {invalid && <FieldError>{error}</FieldError>}
      </FieldContent>
      <InputGroup className={CONTROL}>
        <InputGroupInput
          id={id}
          inputMode="numeric"
          placeholder={placeholder}
          value={value}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
        />
        <InputGroupAddon align="inline-end" className={INPUT_GROUP_UNIT}>
          {unit}
        </InputGroupAddon>
      </InputGroup>
    </Field>
  );
}

/** What a row that owns its own steps will do, read off those steps. */
function ownDefinition(automation: Automation): TemplateDefinition {
  return {
    kind: automation.kind,
    triggers: automation.triggers,
    conditions: automation.conditions,
    actions: automation.actions,
    scope: {},
    enforceAcrossServers: automation.enforceAcrossServers,
  };
}
