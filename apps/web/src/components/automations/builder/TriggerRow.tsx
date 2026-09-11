import { useTranslation } from 'react-i18next';
import type { TriggerNode } from '@tracearr/shared';
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item';
import { NumericInput } from '@/components/ui/numeric-input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { triggerIcon, triggerLabel } from '@/lib/automations';
import { cn } from '@/lib/utils';
import {
  nodeDomId,
  TRIGGER_PARAM_BOUNDS,
  type BuilderDispatch,
  type TriggerParamPatch,
} from './builderReducer';
import { RowActions, RowIssues } from './RowActions';
import type { RowProps } from './useRowKeyboard';
import type { BuilderIssue } from './validation';

/** The row's own sentence, with the threshold sitting inside it where it is read. */
function TriggerTitle({
  trigger,
  setParam,
}: {
  trigger: TriggerNode;
  setParam: (patch: TriggerParamPatch) => void;
}) {
  const { t } = useTranslation('pages');

  if (trigger.type === 'session.held_for') {
    return (
      <>
        {t('automations.builder.heldFor.prefix')}
        <NumericInput
          aria-label={t('automations.builder.heldFor.minutesLabel')}
          className="h-8 w-16"
          value={trigger.params.minutes}
          min={TRIGGER_PARAM_BOUNDS.minutes.min}
          max={TRIGGER_PARAM_BOUNDS.minutes.max}
          onChange={(minutes) => setParam({ minutes })}
        />
        {t('automations.builder.heldFor.unit')}
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={trigger.params.measure}
          aria-label={t('automations.builder.heldFor.measureLabel')}
          onValueChange={(measure) => {
            if (measure === 'current' || measure === 'total') setParam({ measure });
          }}
        >
          <ToggleGroupItem value="current">
            {t('automations.builder.heldFor.current')}
          </ToggleGroupItem>
          <ToggleGroupItem value="total">{t('automations.builder.heldFor.total')}</ToggleGroupItem>
        </ToggleGroup>
      </>
    );
  }

  if (trigger.type === 'account.inactive_for') {
    return (
      <>
        {t('automations.builder.inactiveFor.prefix')}
        <NumericInput
          aria-label={t('automations.builder.inactiveFor.daysLabel')}
          className="h-8 w-16"
          value={trigger.params.days}
          min={TRIGGER_PARAM_BOUNDS.days.min}
          max={TRIGGER_PARAM_BOUNDS.days.max}
          onChange={(days) => setParam({ days })}
        />
        {t('automations.builder.inactiveFor.unit')}
      </>
    );
  }

  return <>{triggerLabel(t, trigger.type)}</>;
}

interface TriggerRowProps {
  trigger: TriggerNode;
  issues: BuilderIssue[] | undefined;
  pulsing: boolean;
  rowProps: RowProps;
  dispatch: BuilderDispatch;
}

/** One thing that can start the automation, with its threshold in the sentence itself. */
export function TriggerRow({ trigger, issues, pulsing, rowProps, dispatch }: TriggerRowProps) {
  const { t } = useTranslation('pages');
  const name = triggerLabel(t, trigger.type);

  const setParam = (patch: TriggerParamPatch) =>
    dispatch({ type: 'setTriggerParam', id: trigger.id, patch });

  return (
    <Item
      role="listitem"
      id={nodeDomId(trigger.id)}
      variant="outline"
      size="sm"
      {...rowProps}
      data-pulse={pulsing}
      className={cn(
        'bg-card-raised',
        'data-[pulse=true]:ring-primary/60 data-[pulse=true]:ring-2',
        !trigger.enabled && 'opacity-60'
      )}
    >
      <ItemMedia variant="icon" className="@max-lg:order-1">
        {triggerIcon(trigger.type)}
      </ItemMedia>
      <ItemContent className="@max-lg:order-3 @max-lg:basis-full">
        <ItemTitle className="flex-wrap gap-2">
          <TriggerTitle trigger={trigger} setParam={setParam} />
        </ItemTitle>
        <RowIssues issues={issues} />
      </ItemContent>
      <ItemActions className="shrink-0 @max-lg:order-2 @max-lg:ml-auto">
        <RowActions
          name={name}
          enabled={trigger.enabled}
          onToggle={() => dispatch({ type: 'toggleNode', id: trigger.id })}
          onRemove={() => dispatch({ type: 'removeNode', id: trigger.id })}
        />
      </ItemActions>
    </Item>
  );
}
