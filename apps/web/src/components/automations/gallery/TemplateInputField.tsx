import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SEND_BODY_MAX,
  SEND_TITLE_MAX,
  variablesFor,
  type AutomationFilterOptions,
  type Condition,
  type Server,
  type TemplateDefinition,
  type TemplateInput,
  type UnitSystem,
} from '@tracearr/shared';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MultiSelect } from '@/components/ui/multi-select';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { NotificationTextField } from '@/components/automations/NotificationTextField';
import { DestinationsField } from '@/components/automations/builder/DestinationsField';
import { conditionValueView, FieldControl } from '@/components/automations/builder/fields';
import { useUsers } from '@/hooks/queries/useUsers';
import {
  conditionFieldForInput,
  fieldDescriptor,
  messageSlotForInput,
  sendTextSlotForInput,
  templateInputLabel,
} from '@/lib/automations';

/** Longer than a line: the two viewer messages both are, and both want the box. */
const TEXTAREA_OVER = 120;

interface TemplateInputFieldProps {
  input: TemplateInput;
  /** Where the input's value lands, which is what decides a number's control and its unit. */
  definition: TemplateDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
  servers: readonly Server[];
  /** The server the form has bound, if any, so an account picker can narrow to its accounts. */
  boundServerId: string;
  filterOptions: AutomationFilterOptions | undefined;
  unitSystem: UnitSystem;
  /** A required input left empty, once the reader has tried to submit. */
  invalid: boolean;
  /** Label above the control, or left of it once the field group is wide enough. */
  orientation?: 'vertical' | 'responsive';
  /** Told which row has focus, so the sentence can light the clause it wrote. */
  onFocusInput?: (key: string | null) => void;
}

/** One template input as the row that fills it in. */
export function TemplateInputField({
  input,
  definition,
  value,
  onChange,
  servers,
  boundServerId,
  filterOptions,
  unitSystem,
  invalid,
  orientation = 'vertical',
  onFocusInput,
}: TemplateInputFieldProps) {
  const { t } = useTranslation('pages');
  const fieldRef = useRef<HTMLDivElement>(null);
  const controlId = useId();
  const labelId = `${controlId}-label`;
  const label = templateInputLabel(t, input);

  const { data: accountsPage } = useUsers(
    { serverId: boundServerId || undefined, pageSize: 100 },
    { enabled: input.kind === 'account' }
  );
  const { data: identitiesPage } = useUsers(
    { pageSize: 100 },
    { enabled: input.kind === 'person' }
  );

  const pickerLabels = {
    searchPlaceholder: t('automations.builder.searchPlaceholder'),
    emptyText: t('automations.builder.noMatches'),
  };

  // A value that fills a condition is edited exactly as the builder edits that condition,
  // which is where the unit system conversion and the option lists come from.
  const valueField =
    input.kind === 'field_value' ? input.field : conditionFieldForInput(definition, input.key);
  const descriptor = valueField ? fieldDescriptor(valueField) : undefined;
  const conditionView = (current: unknown) => {
    if (!valueField || !descriptor) return undefined;
    const condition = {
      field: valueField,
      operator: descriptor.valueType === 'multiSelect' ? 'in' : 'eq',
      value: current as Condition['value'],
    } satisfies Condition;
    return conditionValueView(t, condition, descriptor, { filterOptions, unitSystem });
  };

  const control = () => {
    switch (input.kind) {
      case 'destinations':
        return (
          <DestinationsField
            label={label}
            labelledBy={labelId}
            value={Array.isArray(value) ? value.map(String) : []}
            onChange={onChange}
          />
        );

      case 'server': {
        const options: ComboboxOption[] = [
          { value: '', label: t('automations.bind.anyServer') },
          ...servers.map((server) => ({ value: server.id, label: server.name })),
        ];
        return (
          <Combobox
            id={controlId}
            value={typeof value === 'string' ? value : ''}
            options={options}
            onChange={onChange}
            placeholder={t('automations.bind.anyServer')}
            {...pickerLabels}
          />
        );
      }

      case 'account': {
        // Unbound, the roster has one row per person, so each of their accounts is offered.
        const options = (accountsPage?.data ?? []).flatMap((person) => {
          const name = person.identityName ?? person.username;
          if (boundServerId) return [{ value: person.id, label: name }];
          return (person.identityServers ?? []).flatMap((account) =>
            account.serverUserId && !account.removedAt
              ? [
                  {
                    value: account.serverUserId,
                    label: servers.length > 1 ? `${name} · ${account.name}` : name,
                  },
                ]
              : []
          );
        });
        return (
          <Combobox
            id={controlId}
            value={typeof value === 'string' ? value : null}
            options={options}
            onChange={onChange}
            placeholder={label}
            {...pickerLabels}
          />
        );
      }

      case 'person':
        return (
          <Combobox
            id={controlId}
            value={typeof value === 'string' ? value : null}
            options={(identitiesPage?.data ?? []).map((identity) => ({
              value: identity.userId,
              label: identity.identityName ?? identity.username,
            }))}
            onChange={onChange}
            placeholder={label}
            {...pickerLabels}
          />
        );

      case 'field_value': {
        const view = conditionView(value ?? []);
        if (!view) return null;
        return (
          <FieldControl
            id={controlId}
            aria-labelledby={labelId}
            spec={view.spec}
            value={view.value}
            onChange={(next) => onChange(view.toStored(next))}
          />
        );
      }

      case 'duration':
        return (
          <FieldControl
            id={controlId}
            aria-labelledby={labelId}
            spec={{
              kind: 'number',
              min: input.min,
              max: input.max,
              unit: t(`automations.units.${input.unit}`),
            }}
            value={typeof value === 'number' ? value : (input.default ?? input.min ?? 1)}
            onChange={onChange}
          />
        );

      case 'number': {
        const view = conditionView(typeof value === 'number' ? value : (input.default ?? 0));
        if (view) {
          return (
            <FieldControl
              id={controlId}
              aria-labelledby={labelId}
              spec={view.spec}
              value={view.value}
              onChange={(next) => onChange(view.toStored(next))}
            />
          );
        }
        return (
          <FieldControl
            id={controlId}
            aria-labelledby={labelId}
            spec={{
              kind: 'number',
              min: input.min,
              max: input.max,
              step: input.step,
              unit: input.unit,
            }}
            value={typeof value === 'number' ? value : (input.default ?? input.min ?? 0)}
            onChange={onChange}
          />
        );
      }

      case 'boolean':
        return (
          <Switch
            id={controlId}
            checked={value === true}
            onCheckedChange={onChange}
            aria-labelledby={labelId}
          />
        );

      case 'select': {
        const options = input.options.map((option) => ({
          value: option.value,
          label: option.label,
        }));
        if (input.multiple) {
          return (
            <MultiSelect
              id={controlId}
              aria-labelledby={labelId}
              options={options}
              value={Array.isArray(value) ? value.map(String) : []}
              onChange={onChange}
              placeholder={label}
              searchPlaceholder={pickerLabels.searchPlaceholder}
              emptyMessage={pickerLabels.emptyText}
              clearLabel={t('automations.builder.clearSelection')}
              countLabel={(count) => t('automations.builder.selectedCount', { count })}
            />
          );
        }
        return (
          <Select value={typeof value === 'string' ? value : ''} onValueChange={onChange}>
            <SelectTrigger id={controlId} aria-labelledby={labelId}>
              <SelectValue placeholder={label} />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      }

      case 'text': {
        const text = typeof value === 'string' ? value : '';
        const sendSlot = sendTextSlotForInput(definition, input.key);
        if (sendSlot) {
          const max = sendSlot === 'body' ? SEND_BODY_MAX : SEND_TITLE_MAX;
          return (
            <NotificationTextField
              id={controlId}
              aria-labelledby={labelId}
              value={text}
              onChange={(next) => onChange(next === '' ? undefined : next)}
              variables={variablesFor(
                definition.triggers.map((trigger) => ({
                  type: trigger.type,
                  enabled: trigger.enabled !== false,
                }))
              )}
              multiline={sendSlot === 'body'}
              maxLength={Math.min(input.maxLength ?? max, max)}
              invalid={invalid}
            />
          );
        }
        const props = {
          id: controlId,
          maxLength: input.maxLength,
          value: text,
          onChange: (event: { target: { value: string } }) => onChange(event.target.value),
        };
        return (input.maxLength ?? 0) > TEXTAREA_OVER ? (
          <Textarea {...props} />
        ) : (
          <Input {...props} />
        );
      }
    }
  };

  // A control the label cannot sit beside takes the whole line; the grid reads this.
  const wide =
    input.kind === 'destinations' ||
    (input.kind === 'select' && input.multiple === true) ||
    (input.kind === 'text' && (input.maxLength ?? 0) > TEXTAREA_OVER) ||
    sendTextSlotForInput(definition, input.key) === 'body' ||
    (input.kind === 'field_value' && descriptor?.valueType === 'multiSelect');

  const messageSlot = messageSlotForInput(definition, input.key);
  // The envelope's own words win; these two slots get the app's when it carries none.
  const ownHelper = messageSlot
    ? t(`automations.bind.helper.${messageSlot}`)
    : input.kind === 'server'
      ? t('automations.bind.serverHelper')
      : undefined;
  const description = input.description ?? ownHelper;

  // Capture catches every control this row can render. A picker's list is portalled away,
  // so focus reaching it is not the reader leaving the row.
  const focus = {
    ref: fieldRef,
    onFocusCapture: () => onFocusInput?.(input.key),
    onBlurCapture: () => {
      if (fieldRef.current?.querySelector<HTMLElement>('[aria-expanded="true"]')) return;
      onFocusInput?.(null);
    },
  };

  if (input.kind === 'boolean') {
    return (
      <Field orientation="horizontal" data-wide {...focus}>
        {control()}
        <FieldContent>
          <FieldLabel id={labelId} htmlFor={controlId}>
            {label}
          </FieldLabel>
          {description && <FieldDescription>{description}</FieldDescription>}
        </FieldContent>
      </Field>
    );
  }

  // Destinations are a chip group with no single control to point a label at.
  const labelFor = input.kind === 'destinations' ? undefined : controlId;

  const labelNode = (
    <FieldLabel id={labelId} htmlFor={labelFor}>
      {label}
    </FieldLabel>
  );
  const notes = (
    <>
      {description && <FieldDescription>{description}</FieldDescription>}
      {invalid && <FieldError>{t('automations.bind.required')}</FieldError>}
    </>
  );
  const problem = invalid || undefined;

  if (wide || orientation === 'vertical') {
    return (
      <Field data-wide={wide || undefined} data-invalid={problem} {...focus}>
        {labelNode}
        {control()}
        {notes}
      </Field>
    );
  }

  // Label left of the control once the group is wide enough; the words it needs
  // travel with the label rather than landing beside the control.
  return (
    <Field orientation="responsive" data-invalid={problem} {...focus}>
      <FieldContent>
        {labelNode}
        {notes}
      </FieldContent>
      {control()}
    </Field>
  );
}
