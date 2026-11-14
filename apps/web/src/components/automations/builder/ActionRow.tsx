import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LeafAction, TemplateVariable } from '@tracearr/shared';
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item';
import {
  actionHint,
  actionIcon,
  actionLabel,
  applyActionFieldChange,
  visibleConfigFields,
} from '@/lib/automations';
import { cn } from '@/lib/utils';
import { idOf, nodeDomId, type BuilderDispatch } from './builderReducer';
import { ActionConfigField } from './fields';
import { RowActions, RowIssues, RowWarning } from './RowActions';
import { SendMessageSection } from './SendMessageSection';
import type { RowProps } from './useRowKeyboard';
import type { BuilderIssue } from './validation';

interface ActionRowProps {
  action: LeafAction;
  variables: readonly TemplateVariable[];
  issues: BuilderIssue[] | undefined;
  pulsing: boolean;
  rowProps: RowProps;
  /** The overflow menu, when the row sits in a list that can be reordered. */
  menu?: ReactNode;
  /** Removal is confirmed by the section, so the row only asks for it. */
  onRemove: () => void;
  dispatch: BuilderDispatch;
}

/** One thing the automation does, with everything it needs on the row itself. */
export function ActionRow({
  action,
  variables,
  issues,
  pulsing,
  rowProps,
  menu,
  onRemove,
  dispatch,
}: ActionRowProps) {
  const { t } = useTranslation('pages');
  const id = idOf(action);
  const name = actionLabel(t, action.type);
  const hint = actionHint(t, action.type);
  const enabled = action.enabled !== false;

  const readValue = (field: string) => (action as unknown as Record<string, unknown>)[field];

  return (
    <Item
      role="listitem"
      id={nodeDomId(id)}
      variant="outline"
      size="sm"
      {...rowProps}
      data-pulse={pulsing}
      className={cn(
        'bg-card dark:bg-card-raised @container items-start',
        'data-[pulse=true]:ring-primary/60 data-[pulse=true]:ring-2',
        !enabled && 'opacity-60'
      )}
    >
      <ItemMedia variant="icon" className="@max-lg:order-1">
        {actionIcon(action.type)}
      </ItemMedia>
      <ItemContent className="gap-3 @max-lg:order-3 @max-lg:basis-full">
        <ItemTitle>{name}</ItemTitle>
        <div className="grid w-full gap-3 @md:grid-cols-2">
          {visibleConfigFields(action).map((field) => (
            <ActionConfigField
              key={field.name}
              t={t}
              field={field}
              value={readValue(field.name)}
              onChange={(value) =>
                dispatch({
                  type: 'setAction',
                  id,
                  action: applyActionFieldChange(action, field.name, value),
                })
              }
            />
          ))}
        </div>
        {action.type === 'send' && (
          <SendMessageSection action={action} variables={variables} dispatch={dispatch} />
        )}
        {hint && <RowWarning message={hint} />}
        <RowIssues issues={issues} />
      </ItemContent>
      <ItemActions className="shrink-0 @max-lg:order-2 @max-lg:ml-auto">
        <RowActions
          name={name}
          enabled={enabled}
          onToggle={() => dispatch({ type: 'toggleNode', id })}
          onRemove={onRemove}
        >
          {menu}
        </RowActions>
      </ItemActions>
    </Item>
  );
}
