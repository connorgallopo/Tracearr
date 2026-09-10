/* eslint-disable @eslint-react/static-components --
 * The icon lookup returns a module-level component, so its reference is stable
 * across renders and nothing remounts. The rule cannot see that through the call.
 */
import { Fragment, useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DESTINATION_KINDS,
  DESTINATION_TYPES,
  EMAIL_SMTP_PRESETS,
  SUBSCRIBABLE_EVENTS,
  addressList,
  type CreateDestinationInput,
  type Destination,
  type DestinationDescriptor,
  type DestinationFieldDescriptor,
  type DestinationKind,
  type NotificationEventType,
  type SubscribableEvent,
  type UpdateDestinationInput,
} from '@tracearr/shared';
import type { PagesTranslations } from '@tracearr/translations';
import { Loader2, Send } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useCreateDestination,
  useTestDestination,
  useTestUnsavedDestination,
  useUpdateDestination,
} from '@/hooks/queries/useDestinations';
import { iconFor } from './destinationIcons';

type CreatableKind = CreateDestinationInput['type'];

/** Everything else reaches a destination through an automation, not a subscription. */
const subscribable = (event: NotificationEventType): event is SubscribableEvent =>
  (SUBSCRIBABLE_EVENTS as readonly NotificationEventType[]).includes(event);

/** Field labels are plain strings on the shared descriptor; the pages resource decides which exist. */
type FieldLabel = keyof PagesTranslations['settings']['destinations']['fields'];
type FieldHint = keyof PagesTranslations['settings']['destinations']['hints'];
type OptionLabel = keyof PagesTranslations['settings']['destinations']['options'];
type GroupLabel = keyof PagesTranslations['settings']['destinations']['groups'];

function isCreatable(kind: DestinationKind): kind is CreatableKind {
  return !DESTINATION_TYPES[kind].builtin;
}

const SMTP_PRESET_HINT_FIELDS = new Set(['username', 'password']);
const EMAIL_SMTP_PRESET_IDS = new Set(Object.keys(EMAIL_SMTP_PRESETS));

/** Resend, SendGrid etc. have a non-obvious username/password convention; the preset's own hint wins over the field's. */
function resolveHint(
  kind: DestinationKind | null,
  field: DestinationFieldDescriptor,
  presetValue: string | undefined
): string | undefined {
  if (
    kind === 'email' &&
    SMTP_PRESET_HINT_FIELDS.has(field.key) &&
    presetValue &&
    EMAIL_SMTP_PRESET_IDS.has(presetValue)
  ) {
    const preset = EMAIL_SMTP_PRESETS[presetValue as keyof typeof EMAIL_SMTP_PRESETS];
    return field.key === 'username' ? preset.usernameHint : preset.passwordHint;
  }
  return field.hint;
}

const CREATABLE_KINDS = DESTINATION_KINDS.filter(isCreatable);

function kindDefaults(kind: CreatableKind): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const field of DESTINATION_TYPES[kind].fields) {
    if (field.default !== undefined) defaults[field.key] = field.default;
  }
  return defaults;
}

interface FieldSection {
  group?: string;
  fields: DestinationFieldDescriptor[];
}

/** Chunks consecutive same-group fields together; an ungrouped field stands alone. */
function fieldSections(fields: readonly DestinationFieldDescriptor[]): FieldSection[] {
  const sections: FieldSection[] = [];
  for (const field of fields) {
    const last = sections[sections.length - 1];
    if (last && field.group !== undefined && last.group === field.group) {
      last.fields.push(field);
    } else {
      sections.push({ group: field.group, fields: [field] });
    }
  }
  return sections;
}

interface DestinationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  destination?: Destination;
  /** Seeds the kind on open and skips the kind grid. */
  initialKind?: DestinationKind;
  onCreated?: (destination: Destination) => void;
}

export function DestinationDialog({
  open,
  onOpenChange,
  mode,
  destination,
  initialKind,
  onCreated,
}: DestinationDialogProps) {
  const { t } = useTranslation(['pages', 'common']);
  const createDestination = useCreateDestination();
  const updateDestination = useUpdateDestination();
  const testSaved = useTestDestination();
  const testUnsaved = useTestUnsavedDestination();

  const [kind, setKind] = useState<DestinationKind | null>(null);
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [events, setEvents] = useState<SubscribableEvent[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [edited, setEdited] = useState<Record<string, boolean>>({});
  const [cleared, setCleared] = useState<Record<string, boolean>>({});
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);

  /** Focus targets for the first invalid field when Save is refused. */
  const nameInputRef = useRef<HTMLInputElement>(null);
  const fieldRefs = useRef<Record<string, HTMLElement | null>>({});
  const setFieldRef = (key: string) => (el: HTMLElement | null) => {
    fieldRefs.current[key] = el;
  };

  /** Read through this instead of closing over `t` directly, so seedKind's identity stays stable across renders. */
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  });

  const seedKind = useCallback((next: CreatableKind) => {
    setKind(next);
    setName(tRef.current(`pages:settings.destinations.types.${DESTINATION_TYPES[next].label}`));
    setEvents(next === 'email' ? [] : [...SUBSCRIBABLE_EVENTS]);
    setValues(kindDefaults(next));
  }, []);

  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && destination) {
      const opened: DestinationDescriptor = DESTINATION_TYPES[destination.type];
      const stored: Record<string, string> = {};
      for (const field of opened.fields) {
        const value = destination.config?.[field.key];
        if (typeof value === 'string') stored[field.key] = value;
      }
      setKind(destination.type);
      setName(destination.name);
      setEnabled(destination.enabled);
      setEvents(destination.events.filter(subscribable));
      setValues(stored);
    } else {
      setEnabled(true);
      if (initialKind && isCreatable(initialKind)) seedKind(initialKind);
      else {
        setKind(null);
        setName('');
        setEvents([]);
        setValues({});
      }
    }
    setEdited({});
    setCleared({});
    setDirty(false);
    setError(null);
    setTouched({});
    setSubmitted(false);
  }, [open, mode, destination, initialKind, seedKind]);

  const descriptor: DestinationDescriptor | null = kind ? DESTINATION_TYPES[kind] : null;
  const isBuiltin = destination?.builtin ?? false;
  const isSaving = createDestination.isPending || updateDestination.isPending;
  const isTesting = testSaved.isPending || testUnsaved.isPending;

  /** A stored secret reads back as null, so an untouched blank box means "keep what the server has". */
  const keepsStoredSecret = (key: string): boolean =>
    mode === 'edit' &&
    !cleared[key] &&
    (values[key] ?? '') === '' &&
    (destination?.secretsSet.includes(key) ?? false);

  const isFilled = (field: DestinationFieldDescriptor): boolean =>
    (values[field.key] ?? '').trim() !== '' || keepsStoredSecret(field.key);

  const canSave =
    name.trim() !== '' && (descriptor?.fields ?? []).filter((f) => f.required).every(isFilled);

  /** An email destination with no alert list has nowhere to deliver a violation. */
  const alertListBlank = kind === 'email' && addressList(values['to'] ?? '').length === 0;
  const receivesViolations = !alertListBlank && events.includes('violation_detected');
  const savedEvents = alertListBlank ? [] : events;

  /** Required errors stay quiet until the field is left or a submit is attempted. */
  const showsError = (key: string): boolean => submitted || touched[key] === true;
  const touch = (key: string) =>
    setTouched((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  const nameMissing = name.trim() === '';
  const nameInvalid = nameMissing && showsError('name');

  const setFieldValue = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setEdited((prev) => ({ ...prev, [key]: true }));
    setCleared((prev) => ({ ...prev, [key]: false }));
    setDirty(true);
  };

  /** A select with presets writes its sibling fields too, so a provider pick fills the form. */
  const selectValue = (field: DestinationFieldDescriptor, value: string) => {
    setFieldValue(field.key, value);
    const preset = field.presets?.[value];
    if (!preset) return;
    for (const [key, sibling] of Object.entries(preset)) setFieldValue(key, sibling);
  };

  const clearSecret = (key: string) => {
    setValues((prev) => ({ ...prev, [key]: '' }));
    setEdited((prev) => ({ ...prev, [key]: true }));
    setCleared((prev) => ({ ...prev, [key]: true }));
    setDirty(true);
  };

  const toggleViolations = (checked: boolean) => {
    setEvents(checked ? [...SUBSCRIBABLE_EVENTS] : []);
    setDirty(true);
  };

  /** Every field, for create and for the unsaved test. */
  const fullConfig = (): Record<string, string> =>
    Object.fromEntries(
      (descriptor?.fields ?? []).map((field) => [field.key, (values[field.key] ?? '').trim()])
    );

  /** Only what the user touched: null clears a secret, an omitted key keeps it. */
  const configPatch = (): Record<string, string | null> => {
    const patch: Record<string, string | null> = {};
    for (const field of descriptor?.fields ?? []) {
      if (cleared[field.key]) {
        patch[field.key] = null;
        continue;
      }
      if (!edited[field.key]) continue;
      const value = (values[field.key] ?? '').trim();
      if (value === '') {
        if (keepsStoredSecret(field.key)) continue;
        patch[field.key] = null;
        continue;
      }
      patch[field.key] = value;
    }
    return patch;
  };

  const handleSave = async () => {
    setSubmitted(true);
    if (!canSave) {
      if (nameMissing) {
        nameInputRef.current?.focus();
      } else {
        const missingField = (descriptor?.fields ?? []).find((f) => f.required && !isFilled(f));
        if (missingField) fieldRefs.current[missingField.key]?.focus();
      }
      return;
    }
    setError(null);
    try {
      if (mode === 'create') {
        if (!kind || !isCreatable(kind)) return;
        const created = await createDestination.mutateAsync({
          name: name.trim(),
          type: kind,
          config: fullConfig(),
          events: savedEvents,
          enabled,
        });
        onCreated?.(created);
      } else if (destination) {
        const data: UpdateDestinationInput = { name: name.trim(), enabled, events: savedEvents };
        const patch = configPatch();
        if (!isBuiltin && Object.keys(patch).length > 0) data.config = patch;
        await updateDestination.mutateAsync({ id: destination.id, data });
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTest = async () => {
    setError(null);
    try {
      if (mode === 'edit' && destination) {
        await testSaved.mutateAsync(destination.id);
      } else if (kind) {
        await testUnsaved.mutateAsync({ type: kind, config: fullConfig() });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const title =
    mode === 'create'
      ? t('pages:settings.destinations.add')
      : `${t('common:actions.edit')} ${destination?.name ?? ''}`.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(72dvh,40rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="gap-1 px-6 pt-5 pr-12 pb-3 text-left">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {kind === 'email'
              ? t('pages:settings.destinations.emailDescription')
              : t('pages:settings.destinations.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="@container/kind-grid min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {descriptor === null ? (
            <div className="grid grid-cols-2 gap-3 @sm/kind-grid:grid-cols-3">
              {CREATABLE_KINDS.map((creatable) => {
                const Icon = iconFor(creatable);
                return (
                  <Button
                    key={creatable}
                    variant="outline"
                    className="h-auto flex-col gap-2 py-4"
                    onClick={() => seedKind(creatable)}
                  >
                    <Icon className="h-5 w-5" />
                    <span className="text-sm">
                      {t(`pages:settings.destinations.types.${DESTINATION_TYPES[creatable].label}`)}
                    </span>
                  </Button>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <Field data-invalid={nameInvalid}>
                <FieldLabel htmlFor="destination-name">
                  {t('common:labels.name')}
                  <span className="text-destructive ml-1">*</span>
                </FieldLabel>
                <Input
                  id="destination-name"
                  ref={nameInputRef}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setDirty(true);
                  }}
                  onBlur={() => touch('name')}
                  aria-invalid={nameInvalid}
                />
                {nameInvalid && <FieldError>{t('common:validation.required')}</FieldError>}
              </Field>

              <Field orientation="horizontal">
                <FieldLabel htmlFor="destination-enabled">{t('common:states.enabled')}</FieldLabel>
                <Switch
                  id="destination-enabled"
                  checked={enabled}
                  onCheckedChange={(checked) => {
                    setEnabled(checked);
                    setDirty(true);
                  }}
                />
              </Field>

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="destination-violations">
                    {t('pages:settings.destinations.receiveViolations')}
                  </FieldLabel>
                  <FieldDescription>
                    {alertListBlank
                      ? t('pages:settings.destinations.receiveViolationsNeedsRecipients')
                      : t('pages:settings.destinations.receiveViolationsHint')}
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="destination-violations"
                  checked={receivesViolations}
                  disabled={alertListBlank}
                  onCheckedChange={toggleViolations}
                />
              </Field>

              {fieldSections(descriptor.fields).map((section) => {
                const fieldEls = section.fields.map((field) => {
                  const inputId = `destination-${field.key}`;
                  const stored = keepsStoredSecret(field.key);
                  const missing = field.required && !isFilled(field);
                  const invalid = missing && showsError(field.key);
                  const hint = resolveHint(kind, field, values['preset']);
                  const inputProps = {
                    id: inputId,
                    ref: setFieldRef(field.key),
                    placeholder: stored
                      ? t('pages:settings.destinations.secretSet')
                      : field.placeholder,
                    value: values[field.key] ?? '',
                    onChange: (e: ChangeEvent<HTMLInputElement>) =>
                      setFieldValue(field.key, e.target.value),
                    onBlur: () => touch(field.key),
                    'aria-invalid': invalid,
                  };

                  return (
                    <Field key={field.key} data-invalid={invalid}>
                      <FieldLabel htmlFor={inputId}>
                        {t(`pages:settings.destinations.fields.${field.label as FieldLabel}`)}
                        {field.required && <span className="text-destructive ml-1">*</span>}
                      </FieldLabel>
                      {field.input === 'secret' ? (
                        <PasswordInput {...inputProps} />
                      ) : field.input === 'select' ? (
                        <Select
                          value={values[field.key] ?? ''}
                          onValueChange={(value) => selectValue(field, value)}
                        >
                          <SelectTrigger
                            id={inputId}
                            aria-invalid={invalid}
                            ref={setFieldRef(field.key)}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(field.options ?? []).map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {t(
                                  `pages:settings.destinations.options.${option.label as OptionLabel}`
                                )}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : field.input === 'number' ? (
                        <Input
                          {...inputProps}
                          type="number"
                          inputMode="numeric"
                          min={field.min}
                          max={field.max}
                        />
                      ) : field.input === 'email' ? (
                        <Input {...inputProps} type="email" autoComplete="off" />
                      ) : (
                        <Input {...inputProps} />
                      )}
                      {hint && !stored && (
                        <FieldDescription>
                          {t(`pages:settings.destinations.hints.${hint as FieldHint}`)}
                        </FieldDescription>
                      )}
                      {stored && (
                        <FieldDescription>
                          <Button
                            type="button"
                            variant="link"
                            size="sm"
                            className="h-auto p-0"
                            onClick={() => clearSecret(field.key)}
                          >
                            {t('pages:settings.destinations.clearSecret')}
                          </Button>
                        </FieldDescription>
                      )}
                      {invalid && <FieldError>{t('common:validation.required')}</FieldError>}
                    </Field>
                  );
                });

                if (section.group === undefined) {
                  return <Fragment key={section.fields[0]?.key}>{fieldEls}</Fragment>;
                }

                return (
                  <Fragment key={section.group}>
                    <FieldSeparator role="presentation" />
                    <FieldSet className="gap-4">
                      <FieldLegend variant="label">
                        {t(`pages:settings.destinations.groups.${section.group as GroupLabel}`)}
                      </FieldLegend>
                      {fieldEls}
                    </FieldSet>
                  </Fragment>
                );
              })}

              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          {descriptor !== null && !isBuiltin && (
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      variant="outline"
                      onClick={handleTest}
                      disabled={isTesting || !canSave || (mode === 'edit' && dirty)}
                    >
                      {isTesting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                      {t('pages:settings.destinations.test')}
                    </Button>
                  </span>
                </TooltipTrigger>
                {mode === 'edit' && dirty ? (
                  <TooltipContent>{t('pages:settings.destinations.testHint')}</TooltipContent>
                ) : !canSave ? (
                  <TooltipContent>{t('pages:settings.destinations.testNeedsForm')}</TooltipContent>
                ) : null}
              </Tooltip>
            </TooltipProvider>
          )}
          {descriptor !== null && (
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              {isSaving ? t('common:states.saving') : t('common:actions.save')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
