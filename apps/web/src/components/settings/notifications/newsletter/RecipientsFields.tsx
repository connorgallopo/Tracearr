import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { addressList, isEmailAddress, NEWSLETTER_EXTRA_ADDRESSES_MAX } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemGroup } from '@/components/ui/item';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useServers } from '@/hooks/queries';
import { formatList } from '@/lib/listFormat';
import { EditorCard } from './EditorCard';
import {
  NEWSLETTER_FIELD_IDS,
  RECIPIENTS_CARD_ID,
  scopedServers,
  type FieldsetProps,
} from './newsletterForm';
import { RecipientsPanel } from './RecipientsPanel';

/** The row shape is fixed by the schema, so a row's key lives beside the state rather than in it. */
let nextRowId = 0;
const mintRowId = () => `extra-${nextRowId++}`;

/** A count set from outside the add and remove handlers, a prefill, is padded or trimmed for the render alone. */
function alignRowIds(ids: readonly string[], count: number): string[] {
  if (ids.length >= count) return ids.slice(0, count);
  return [...ids, ...Array.from({ length: count - ids.length }, (_, i) => `extra-prefill-${i}`)];
}

export function RecipientsFields({
  state,
  onChange,
  errors,
  touch,
  newsletterId,
  savedExcludeUserIds,
}: FieldsetProps & {
  newsletterId: string | null;
  /** The saved row's `recipients.excludeUserIds`, empty before the first save; whatever the form changed from it is badged until Save. */
  savedExcludeUserIds: string[];
}) {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const { data: servers } = useServers();
  const { recipients } = state;
  const scoped = scopedServers(state.scope, servers ?? []);
  const rowCount = recipients.extraAddresses.length;
  const [rowIds, setRowIds] = useState<string[]>(() => recipients.extraAddresses.map(mintRowId));
  const [blurred, setBlurred] = useState<string[]>([]);
  const [pasted, setPasted] = useState('');
  const [extrasOpen, setExtrasOpen] = useState(rowCount > 0);
  const [hadRows, setHadRows] = useState(rowCount > 0);
  if (hadRows !== rowCount > 0) {
    setHadRows(rowCount > 0);
    if (rowCount > 0) setExtrasOpen(true);
  }
  const extrasShown = extrasOpen || errors.recipients !== undefined;
  const full = rowCount >= NEWSLETTER_EXTRA_ADDRESSES_MAX;
  const keys = alignRowIds(rowIds, rowCount);

  const setRecipients = (patch: Partial<typeof recipients>) => {
    touch('recipients');
    onChange({ recipients: { ...recipients, ...patch } });
  };
  const setRow = (index: number, patch: { address?: string; name?: string }) =>
    setRecipients({
      extraAddresses: recipients.extraAddresses.map((row, i) =>
        i === index ? { ...row, ...patch } : row
      ),
    });
  const removeRow = (index: number) => {
    setRowIds((ids) => ids.filter((_, i) => i !== index));
    setRecipients({
      extraAddresses: recipients.extraAddresses.filter((_, i) => i !== index),
    });
  };
  /** Anything past the max stays in the box; a pasted row that isn't an address shows its error at once. */
  const addPasted = () => {
    const taken = new Set(recipients.extraAddresses.map((row) => row.address.trim().toLowerCase()));
    const fresh: string[] = [];
    for (const typed of addressList(pasted.replace(/\r?\n/g, ','))) {
      const key = typed.toLowerCase();
      if (taken.has(key)) continue;
      taken.add(key);
      fresh.push(typed);
    }
    const room = NEWSLETTER_EXTRA_ADDRESSES_MAX - rowCount;
    const added = fresh.slice(0, room);
    const ids = added.map(mintRowId);
    setRowIds([...keys, ...ids]);
    setBlurred((current) => [...current, ...ids]);
    setPasted(fresh.slice(room).join('\n'));
    if (added.length > 0) {
      setRecipients({
        extraAddresses: [
          ...recipients.extraAddresses,
          ...added.map((typed) => ({ address: typed })),
        ],
      });
    }
  };

  return (
    <EditorCard id={RECIPIENTS_CARD_ID} title={t('newsletters.editor.recipients.title')}>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.members}>
            {t('newsletters.editor.recipients.members')}
          </FieldLabel>
          {scoped.length > 0 && (
            <FieldDescription>
              {t('newsletters.editor.recipients.membersHelp', {
                servers: formatList(
                  i18n.language,
                  scoped.map((server) => server.name)
                ),
              })}
            </FieldDescription>
          )}
          <FieldDescription>{t('newsletters.editor.recipients.ownerNote')}</FieldDescription>
        </FieldContent>
        <Switch
          id={NEWSLETTER_FIELD_IDS.members}
          checked={recipients.members}
          onCheckedChange={(members) => setRecipients({ members })}
          aria-label={t('newsletters.editor.recipients.members')}
        />
      </Field>
      <RecipientsPanel
        form={state}
        newsletterId={newsletterId}
        savedExcludeUserIds={savedExcludeUserIds}
        servers={scoped.map((s) => ({ id: s.id, name: s.name }))}
        onExclude={(userIds) =>
          setRecipients({
            excludeUserIds: [
              ...recipients.excludeUserIds,
              ...userIds.filter((id) => !recipients.excludeUserIds.includes(id)),
            ],
          })
        }
        onInclude={(userIds) =>
          setRecipients({
            excludeUserIds: recipients.excludeUserIds.filter((id) => !userIds.includes(id)),
          })
        }
      />
      <Collapsible open={extrasShown} onOpenChange={setExtrasOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm">
            {extrasShown ? <ChevronDown /> : <ChevronRight />}
            {t('newsletters.editor.recipients.extraTrigger', { count: rowCount })}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-2 pt-2">
          <FieldDescription>{t('newsletters.editor.recipients.extraHelp')}</FieldDescription>
          {rowCount > 0 && (
            <ItemGroup className="gap-1">
              {recipients.extraAddresses.map((row, index) => {
                const rowId = keys[index] ?? `extra-${index}`;
                const bad =
                  blurred.includes(rowId) && row.address !== '' && !isEmailAddress(row.address);
                return (
                  <Item
                    key={rowId}
                    role="listitem"
                    variant="outline"
                    size="sm"
                    className="flex-wrap"
                  >
                    <ItemContent className="flex-row flex-wrap gap-2">
                      <Input
                        className="max-w-xs"
                        type="email"
                        value={row.address}
                        aria-invalid={bad}
                        aria-label={t('newsletters.editor.recipients.addressLabel', {
                          n: index + 1,
                        })}
                        placeholder="someone@example.com"
                        onChange={(event) => setRow(index, { address: event.target.value })}
                        onBlur={() => {
                          setBlurred((ids) => (ids.includes(rowId) ? ids : [...ids, rowId]));
                          touch('recipients');
                        }}
                      />
                      <Input
                        className="max-w-48"
                        value={row.name ?? ''}
                        maxLength={100}
                        aria-label={t('newsletters.editor.recipients.nameLabel', { n: index + 1 })}
                        placeholder={t('newsletters.editor.recipients.namePlaceholder')}
                        onChange={(event) =>
                          setRow(index, {
                            name: event.target.value === '' ? undefined : event.target.value,
                          })
                        }
                      />
                      {bad && (
                        <FieldError className="basis-full">
                          {t('newsletters.editor.recipients.badAddress')}
                        </FieldError>
                      )}
                    </ItemContent>
                    <ItemActions>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('newsletters.editor.recipients.removeAddress', {
                          n: index + 1,
                        })}
                        onClick={() => removeRow(index)}
                      >
                        <Trash2 />
                      </Button>
                    </ItemActions>
                  </Item>
                );
              })}
            </ItemGroup>
          )}
          <Textarea
            value={pasted}
            disabled={full}
            aria-label={t('newsletters.editor.recipients.pasteAddresses')}
            placeholder={t('newsletters.editor.recipients.pasteAddresses')}
            onChange={(event) => setPasted(event.target.value)}
          />
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={full || pasted.trim() === ''}
              onClick={addPasted}
            >
              <Plus />
              {t('common:actions.add')}
            </Button>
          </div>
          <FieldError>{errors.recipients}</FieldError>
        </CollapsibleContent>
      </Collapsible>
    </EditorCard>
  );
}
