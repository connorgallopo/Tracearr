import { useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Plus } from 'lucide-react';
import type { IfAction, LeafActionType, TemplateVariable } from '@tracearr/shared';
import { LEAF_ACTION_TYPES } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { FieldSeparator } from '@/components/ui/field';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import {
  actionIcon,
  actionPickerEntries,
  capitalize,
  describeConditions,
  suggestedValues,
} from '@/lib/automations';
import { cn } from '@/lib/utils';
import { idOf, nodeDomId, type BuilderDispatch } from './builderReducer';
import { ActionRow } from './ActionRow';
import { ConditionGroupCard } from './ConditionGroupCard';
import { NodePicker } from './NodePicker';
import { RowActions, RowIssues } from './RowActions';
import { useRowKeyboard } from './useRowKeyboard';
import type { BranchExpansion, BuilderRefs } from './builderRefs';
import type { RowProps } from './useRowKeyboard';
import type { NodeIssues } from './validation';

interface IfRowProps {
  action: IfAction;
  variables: readonly TemplateVariable[];
  refs: BuilderRefs;
  issues: NodeIssues;
  pulseId: string | null;
  rowProps: RowProps;
  expansion: BranchExpansion;
  menu?: ReactNode;
  onRemove: () => void;
  onRemoveBranchAction: (id: string, reclaim: () => void) => void;
  dispatch: BuilderDispatch;
}

function isLeafActionType(value: string): value is LeafActionType {
  return (LEAF_ACTION_TYPES as readonly string[]).includes(value);
}

/** A fork in the run: what holds decides which set of steps happens. */
export function IfRow({
  action,
  variables,
  refs,
  issues,
  pulseId,
  rowProps,
  expansion,
  menu,
  onRemove,
  onRemoveBranchAction,
  dispatch,
}: IfRowProps) {
  const { t } = useTranslation('pages');
  const id = idOf(action);
  const open = expansion.isOpen(id);
  const enabled = action.enabled !== false;
  const groups = action.conditions.groups;
  const firstGroup = groups[0];
  // The chevron sits outside the Collapsible, so it names the panel it opens itself.
  const branchId = `${nodeDomId(id)}-branch`;

  const summary = useMemo(() => {
    const fragments = describeConditions(
      action.conditions.groups,
      refs.describe,
      t,
      refs.unitSystem
    );
    const text =
      fragments.length > 0
        ? fragments.map((fragment) => fragment.text).join(' ')
        : t('automations.builder.actions.ifNothing');
    return `${capitalize(t('automations.describe.actions.if'))} ${text}`;
  }, [action.conditions.groups, refs, t]);

  return (
    <Item
      role="listitem"
      id={nodeDomId(id)}
      variant="outline"
      size="sm"
      {...rowProps}
      data-pulse={pulseId === id}
      className={cn(
        'bg-card dark:bg-card-raised @container flex-col items-stretch gap-3',
        'data-[pulse=true]:ring-primary/60 data-[pulse=true]:ring-2',
        !enabled && 'opacity-60'
      )}
    >
      <div className="flex w-full flex-wrap items-start gap-3">
        <ItemMedia variant="icon" className="@max-lg:order-1">
          {actionIcon('if')}
        </ItemMedia>
        <ItemContent className="@max-lg:order-3 @max-lg:basis-full">
          <ItemTitle className="flex-wrap">
            {open ? t('automations.builder.actions.ifTitle') : summary}
          </ItemTitle>
        </ItemContent>
        <ItemActions className="shrink-0 @max-lg:order-2 @max-lg:ml-auto">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-expanded={open}
            aria-controls={branchId}
            aria-label={
              open
                ? t('automations.builder.actions.collapseBranch')
                : t('automations.builder.actions.expandBranch')
            }
            onClick={() => expansion.toggle(id)}
          >
            <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
          </Button>
          <RowActions
            name={t('automations.builder.actions.branchName')}
            enabled={enabled}
            onToggle={() => dispatch({ type: 'toggleNode', id })}
            onRemove={onRemove}
          >
            {menu}
          </RowActions>
        </ItemActions>
      </div>

      <Collapsible open={open} onOpenChange={() => expansion.toggle(id)}>
        <CollapsibleContent
          id={branchId}
          className="border-primary/40 [&_[data-slot=item]:not([data-orphaned=true])]:bg-card-raised dark:[&_[data-slot=item]:not([data-orphaned=true])]:bg-card ml-3 space-y-3 border-l-2 pl-3.5 @max-lg:ml-1 @max-lg:pl-2.5"
        >
          {/* The header said "If", so the checks go straight underneath with no second label. */}
          {groups.map((group) => (
            <ConditionGroupCard
              key={idOf(group)}
              group={group}
              refs={refs}
              issues={issues}
              pulseId={pulseId}
              bare={groups.length === 1}
              dispatch={dispatch}
            />
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() =>
              firstGroup
                ? dispatch({ type: 'addCondition', groupId: idOf(firstGroup) })
                : dispatch({ type: 'addConditionGroup', ifId: id })
            }
          >
            <Plus />
            {t('automations.builder.actions.ifAddCheck')}
          </Button>
          <RowIssues issues={issues.get(id)} />

          <FieldSeparator align="start" surface="panel">
            <span className="text-foreground font-medium">
              {t('automations.builder.actions.branchThen')}
            </span>
          </FieldSeparator>
          <Branch
            ifId={id}
            side="then"
            actions={action.then}
            variables={variables}
            issues={issues}
            pulseId={pulseId}
            onRemoveBranchAction={onRemoveBranchAction}
            dispatch={dispatch}
          />

          <FieldSeparator align="start" surface="panel">
            <span className="text-foreground font-medium">
              {t('automations.builder.actions.branchElse')}
            </span>
          </FieldSeparator>
          <Branch
            ifId={id}
            side="else"
            actions={action.else}
            variables={variables}
            emptyText={t('automations.builder.actions.branchElseEmpty')}
            issues={issues}
            pulseId={pulseId}
            onRemoveBranchAction={onRemoveBranchAction}
            dispatch={dispatch}
          />

          {refs.kind === 'policy' && (
            <p className="text-muted-foreground text-xs">
              {t('automations.builder.actions.policyNote')}
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </Item>
  );
}

interface BranchProps {
  ifId: string;
  side: 'then' | 'else';
  actions: IfAction['then'];
  variables: readonly TemplateVariable[];
  /** What this side does while it holds nothing, said in words rather than left blank. */
  emptyText?: string;
  issues: NodeIssues;
  pulseId: string | null;
  onRemoveBranchAction: (id: string, reclaim: () => void) => void;
  dispatch: BuilderDispatch;
}

/** One side of the fork: its own list of effects, and its own picker without `if`. */
function Branch({
  ifId,
  side,
  actions,
  variables,
  emptyText,
  issues,
  pulseId,
  onRemoveBranchAction,
  dispatch,
}: BranchProps) {
  const { t } = useTranslation('pages');
  const branchRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => actionPickerEntries(t, { branch: true }), [t]);
  const suggested = useMemo(
    () =>
      suggestedValues(
        entries,
        actions.map((action) => action.type)
      ),
    [entries, actions]
  );

  const rows = useRowKeyboard({
    ids: actions.map(idOf),
    sectionRef: branchRef,
    onToggle: (id) => dispatch({ type: 'toggleNode', id }),
    onRemove: (id, index) => onRemoveBranchAction(id, () => rows.reclaim(index)),
    onMove: (id, delta) => dispatch({ type: 'moveAction', id, delta }),
  });

  return (
    <div ref={branchRef} className="space-y-2">
      {actions.length > 0 && (
        <ItemGroup className="gap-2">
          {actions.map((action, index) => (
            <ActionRow
              key={idOf(action)}
              action={action}
              variables={variables}
              issues={issues.get(idOf(action))}
              pulsing={pulseId === idOf(action)}
              rowProps={rows.rowProps(index)}
              onRemove={() => onRemoveBranchAction(idOf(action), () => rows.reclaim(index))}
              dispatch={dispatch}
            />
          ))}
        </ItemGroup>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {actions.length === 0 && emptyText !== undefined && (
          <span className="text-muted-foreground text-sm">{emptyText}</span>
        )}
        <NodePicker
          entries={entries}
          suggested={suggested}
          label={t('automations.builder.actions.addBranch')}
          onSelect={(value) => {
            if (isLeafActionType(value)) {
              dispatch({ type: 'addAction', actionType: value, branch: { ifId, side } });
            }
          }}
        />
      </div>
    </div>
  );
}
