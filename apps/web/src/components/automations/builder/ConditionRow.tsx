import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  contextOf,
  fieldsAvailableFor,
  type Condition,
  type ConditionField,
  type Operator,
} from '@tracearr/shared';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Item, ItemActions } from '@/components/ui/item';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  categoryLabel,
  defaultParamsForField,
  fieldDescription,
  fieldDescriptor,
  fieldLabel,
  fieldsByCategory,
  getDefaultOperatorForField,
  getDefaultValueForField,
  isArrayOperator,
  operatorLabel,
  orphaningTriggers,
  unreachableNote,
  FIELD_CATEGORIES,
} from '@/lib/automations';
import { cn } from '@/lib/utils';
import { idOf, nodeDomId, type BuilderDispatch } from './builderReducer';
import { ConditionParams, FieldControl, conditionValueView } from './fields';
import { RowActions, RowIssues, RowWarning } from './RowActions';
import type { BuilderRefs } from './builderRefs';
import type { RowProps } from './useRowKeyboard';
import type { BuilderIssue } from './validation';

interface ConditionRowProps {
  condition: Condition;
  refs: BuilderRefs;
  issues: BuilderIssue[] | undefined;
  pulsing: boolean;
  rowProps: RowProps;
  dispatch: BuilderDispatch;
}

export function ConditionRow({
  condition,
  refs,
  issues,
  pulsing,
  rowProps,
  dispatch,
}: ConditionRowProps) {
  const { t } = useTranslation('pages');
  const id = idOf(condition);
  const descriptor = fieldDescriptor(condition.field);

  const available = useMemo(
    () => new Set(fieldsAvailableFor(contextOf(refs.triggers))),
    [refs.triggers]
  );
  const options = useMemo<ComboboxOption<ConditionField>[]>(() => {
    const byCategory = fieldsByCategory();
    return FIELD_CATEGORIES.flatMap((category) =>
      byCategory[category]
        // The row's own field stays listed so the picker keeps a label for it.
        .filter((field) => available.has(field) || field === condition.field)
        .map((field) => ({
          value: field,
          label: fieldLabel(t, field),
          description: fieldDescription(t, field),
          group: categoryLabel(t, category),
        }))
    );
  }, [available, condition.field, t]);

  // A stored automation can carry a field this build no longer defines
  // (library_id was removed); rendering nothing beats taking the page down.
  if (!descriptor) return null;

  const change = (next: Condition) =>
    dispatch({ type: 'setCondition', id, condition: { ...next, id, enabled: condition.enabled } });

  const changeField = (field: ConditionField) => {
    const params = defaultParamsForField(field);
    change({
      field,
      operator: getDefaultOperatorForField(field),
      value: getDefaultValueForField(field),
      ...(Object.keys(params).length > 0 ? { params } : {}),
    });
  };

  const changeOperator = (operator: Operator) => {
    const wasArray = isArrayOperator(condition.operator);
    const isArray = isArrayOperator(operator);

    let value = condition.value;
    if (wasArray && !isArray && Array.isArray(condition.value)) {
      value = condition.value[0] ?? getDefaultValueForField(condition.field);
    } else if (!wasArray && isArray && !Array.isArray(condition.value)) {
      value = condition.value ? [String(condition.value)] : [];
    }
    change({ ...condition, operator, value });
  };

  const view = conditionValueView(t, condition, descriptor, {
    filterOptions: refs.filterOptions,
    unitSystem: refs.unitSystem,
  });
  const name = fieldLabel(t, condition.field);
  const orphaned = orphaningTriggers(t, refs.triggers, condition.field);
  const unreachable = unreachableNote(t, refs.triggers, condition, refs.conditions);
  const enabled = condition.enabled !== false;

  return (
    <Item
      role="listitem"
      id={nodeDomId(id)}
      variant="outline"
      size="sm"
      {...rowProps}
      data-pulse={pulsing}
      data-orphaned={orphaned.length > 0}
      className={cn(
        'bg-card dark:bg-card-raised items-center',
        'data-[pulse=true]:ring-primary/60 data-[pulse=true]:ring-2',
        'data-[orphaned=true]:border-l-warning data-[orphaned=true]:bg-warning/5 dark:data-[orphaned=true]:bg-warning/5 data-[orphaned=true]:border-l-2',
        !enabled && 'opacity-60'
      )}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 @max-lg:order-3 @max-lg:basis-full">
        <Combobox
          aria-label={t('automations.builder.conditions.fieldLabel')}
          className="min-w-40 flex-1 @max-lg:basis-full"
          value={condition.field}
          options={options}
          onChange={changeField}
          placeholder={t('automations.builder.conditions.fieldPlaceholder')}
          searchPlaceholder={t('automations.builder.searchPlaceholder')}
          emptyText={t('automations.builder.noMatches')}
        />

        <Select value={condition.operator} onValueChange={changeOperator}>
          <SelectTrigger
            className="w-auto @max-lg:w-full"
            aria-label={t('automations.builder.conditions.operatorLabel')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {descriptor.operators.map((operator) => (
              <SelectItem key={operator} value={operator}>
                {operatorLabel(t, operator)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="min-w-36 flex-1 @max-lg:basis-full">
          <FieldControl
            spec={view.spec}
            value={view.value}
            aria-label={t('automations.builder.conditions.valueLabel')}
            onChange={(next) => change({ ...condition, value: view.toStored(next) })}
          />
        </div>

        <ConditionParams condition={condition} descriptor={descriptor} onChange={change} />

        {(issues !== undefined || unreachable !== null) && (
          <div className="basis-full">
            <RowIssues issues={issues} />
            {unreachable && <RowWarning message={unreachable} />}
          </div>
        )}
      </div>

      <ItemActions className="shrink-0 @max-lg:order-2 @max-lg:ml-auto">
        <RowActions
          name={name}
          enabled={enabled}
          onToggle={() => dispatch({ type: 'toggleNode', id })}
          onRemove={() => dispatch({ type: 'removeNode', id })}
        />
      </ItemActions>
    </Item>
  );
}
