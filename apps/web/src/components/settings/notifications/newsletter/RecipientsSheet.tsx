import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldDescription } from '@/components/ui/field';
import { SearchField } from '@/components/ui/filters/fields/search-field';
import { ItemGroup } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useRowSelection } from '@/hooks/useRowSelection';
import { formatList } from '@/lib/listFormat';
import { EntryRow, entryName, useTranslate, type EntryActions } from './RecipientRows';
import {
  entryOnServer,
  entryUserId,
  excludedEntry,
  groupByVariant,
  matchesSearch,
  missingEntry,
  recipientEntry,
  selectableId,
  type PendingChange,
  type RecipientEntry,
  type RecipientPartition,
} from './recipientsView';

const TABS = ['receiving', 'excluded', 'noAddress', 'suppressed'] as const;
type Tab = (typeof TABS)[number];

const ALL_SERVERS = 'all';

const byId = (id: string) => id;

export function RecipientsSheet({
  open,
  onOpenChange,
  partition,
  servers,
  pending,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partition: RecipientPartition;
  servers: { id: string; name: string }[];
  pending: (userId: string | null) => PendingChange;
  actions: EntryActions;
}) {
  const { t, i18n } = useTranslate();
  const selectAllId = useId();
  const [tab, setTab] = useState<Tab>('receiving');
  const [search, setSearch] = useState<string | undefined>(undefined);
  const [serverId, setServerId] = useState(ALL_SERVERS);
  const { isSelected, toggleRow, togglePage, clearSelection, isPageSelected, isPageIndeterminate } =
    useRowSelection({ getRowId: byId });

  const entries: Record<Tab, RecipientEntry[]> = {
    receiving: partition.receive.map(recipientEntry),
    excluded: [...partition.excluded, ...partition.notIncludable].map(excludedEntry),
    noAddress: partition.missing.map(missingEntry),
    suppressed: partition.suppressed.map(recipientEntry),
  };
  const counts: Record<Tab, number> = {
    receiving: partition.receive.length,
    excluded: partition.excluded.length,
    noAddress: partition.missing.length,
    suppressed: partition.suppressed.length,
  };
  const help: Record<Tab, string | null> = {
    receiving: null,
    excluded: t('newsletters.editor.recipients.excludedHelp'),
    noAddress: t('newsletters.editor.recipients.noAddressHelp'),
    suppressed: t('newsletters.editor.recipients.suppressedHelp'),
  };
  const tabs = TABS.filter((id) => id === 'receiving' || entries[id].length > 0);
  const active = tabs.includes(tab) ? tab : 'receiving';
  const scopedIds = servers.map((s) => s.id);
  const visible = entries[active].filter(
    (entry) =>
      matchesSearch(entry, search) &&
      (serverId === ALL_SERVERS || entryOnServer(entry, serverId, scopedIds))
  );
  const selectable = visible.flatMap((entry) => {
    const id = selectableId(entry);
    return id === null ? [] : [id];
  });
  const chosen = selectable.filter(isSelected);
  const including = active === 'excluded';

  const narrow = (apply: () => void) => {
    apply();
    clearSelection();
  };
  const moveChosen = () => {
    (including ? actions.onInclude : actions.onExclude)(chosen);
    clearSelection();
  };

  const row = (entry: RecipientEntry) => {
    const id = selectableId(entry);
    return (
      <EntryRow
        key={entry.key}
        entry={entry}
        pending={pending(entryUserId(entry))}
        actions={actions}
        select={
          id !== null && (
            <Checkbox
              checked={isSelected(id)}
              onCheckedChange={() => toggleRow(id)}
              aria-label={t('newsletters.editor.recipients.selectPerson', {
                name: entryName(entry, t),
              })}
            />
          )
        }
      />
    );
  };

  const receiving = () => {
    const groups = groupByVariant(
      visible.flatMap((entry) => (entry.kind === 'recipient' ? [entry.row] : [])),
      servers
    );
    return (
      <>
        {groups.length > 1 && (
          <FieldDescription>{t('newsletters.editor.recipients.groupsNote')}</FieldDescription>
        )}
        {groups.map((group) => (
          <div key={group.key}>
            {groups.length > 1 && (
              <p className="text-muted-foreground mb-2 text-xs font-medium">
                {t('newsletters.editor.variantHeading', {
                  count: group.rows.length,
                  servers: formatList(i18n.language, group.serverNames),
                })}
              </p>
            )}
            <ItemGroup className="gap-1">{group.rows.map((r) => row(recipientEntry(r)))}</ItemGroup>
          </div>
        ))}
      </>
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) clearSelection();
        onOpenChange(next);
      }}
    >
      <SheetContent className="flex flex-col overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t('newsletters.editor.recipients.title')}</SheetTitle>
          <SheetDescription>{t('newsletters.editor.recipients.manageHelp')}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4">
          <div className="flex flex-wrap items-center gap-2">
            <SearchField
              className="min-w-48 flex-1"
              value={search}
              onChange={(next) => narrow(() => setSearch(next))}
              placeholder={t('newsletters.editor.recipients.searchPlaceholder')}
              clearLabel={t('common:filters.clearSearch')}
              aria-label={t('common:actions.search')}
            />
            {servers.length > 1 && (
              <Select value={serverId} onValueChange={(next) => narrow(() => setServerId(next))}>
                <SelectTrigger
                  className="w-full sm:w-44"
                  aria-label={t('newsletters.editor.recipients.serverFilter')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_SERVERS}>
                    {t('newsletters.editor.recipients.allServers')}
                  </SelectItem>
                  {servers.map((server) => (
                    <SelectItem key={server.id} value={server.id}>
                      {server.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <Tabs
            value={active}
            onValueChange={(value) => {
              const next = TABS.find((id) => id === value);
              if (next) narrow(() => setTab(next));
            }}
          >
            <TabsList variant="line" className="w-full justify-start overflow-x-auto">
              {tabs.map((id) => (
                <TabsTrigger key={id} value={id} className="flex-none">
                  {t(`newsletters.editor.recipients.tabs.${id}`, { count: counts[id] })}
                </TabsTrigger>
              ))}
            </TabsList>
            {tabs.map((id) => (
              <TabsContent key={id} value={id} className="flex flex-col gap-2">
                {help[id] && <FieldDescription>{help[id]}</FieldDescription>}
                {id === 'excluded' && partition.notIncludable.length > 0 && (
                  <FieldDescription>
                    {t('newsletters.editor.recipients.notIncludableHelp', {
                      count: partition.notIncludable.length,
                    })}
                  </FieldDescription>
                )}
                {selectable.length > 0 && (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={selectAllId}
                      checked={
                        isPageSelected(selectable)
                          ? true
                          : isPageIndeterminate(selectable)
                            ? 'indeterminate'
                            : false
                      }
                      onCheckedChange={() => togglePage(selectable)}
                    />
                    <Label htmlFor={selectAllId} className="font-normal">
                      {t('newsletters.editor.recipients.selectAll', { count: selectable.length })}
                    </Label>
                  </div>
                )}
                {visible.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {t('newsletters.editor.recipients.noMatches')}
                  </p>
                ) : id === 'receiving' ? (
                  receiving()
                ) : (
                  <ItemGroup className="gap-1">{visible.map(row)}</ItemGroup>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </div>
        {active !== 'noAddress' && (
          <SheetFooter className="bg-background sticky bottom-0 flex-row items-center justify-between border-t">
            <span className="text-muted-foreground text-sm">
              {t('newsletters.editor.recipients.selectedCount', { count: chosen.length })}
            </span>
            <Button type="button" disabled={chosen.length === 0} onClick={moveChosen}>
              {including
                ? t('newsletters.editor.recipients.includeSelected')
                : t('newsletters.editor.recipients.excludeSelected')}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
