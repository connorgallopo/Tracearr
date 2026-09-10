import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { NEWSLETTER_EXTRA_ADDRESSES_MAX } from '@tracearr/shared';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
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
import { useServers } from '@/hooks/queries';
import { formatList } from '@/lib/listFormat';
import { RecipientsPanel } from './RecipientsPanel';
import { EditorCard } from './EditorCard';
import {
  NEWSLETTER_FIELD_IDS,
  RECIPIENTS_CARD_ID,
  scopeMoved,
  scopedServers,
  type FieldsetProps,
} from './newsletterForm';

const address = z.email();

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
  savedServerIds,
  onPreview,
}: FieldsetProps & {
  newsletterId: string | null;
  /** The saved row's `scope.serverIds`, or null before the first save; the panel reads the saved row, so a moved scope is flagged. */
  savedServerIds: string[] | null;
  onPreview: () => void;
}) {
  const { t, i18n } = useTranslation('settings');
  const { data: servers } = useServers();
  const { recipients } = state;
  const scoped = scopedServers(state.scope, servers ?? []);
  const [rowIds, setRowIds] = useState<string[]>(() => recipients.extraAddresses.map(mintRowId));
  const [blurred, setBlurred] = useState<string[]>([]);
  const keys = alignRowIds(rowIds, recipients.extraAddresses.length);

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
  const addRow = () => {
    setRowIds((ids) => [...ids, mintRowId()]);
    setRecipients({ extraAddresses: [...recipients.extraAddresses, { address: '' }] });
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
      <div className="flex flex-col gap-2">
        <FieldLabel>{t('newsletters.editor.recipients.extraAddresses')}</FieldLabel>
        <FieldDescription>{t('newsletters.editor.recipients.extraAddressesHelp')}</FieldDescription>
        <ItemGroup className="gap-1">
          {recipients.extraAddresses.map((row, index) => {
            const rowId = keys[index] ?? `extra-${index}`;
            const bad =
              blurred.includes(rowId) &&
              row.address !== '' &&
              !address.safeParse(row.address).success;
            return (
              <Item key={rowId} role="listitem" variant="outline" size="sm" className="flex-wrap">
                <ItemContent className="flex-row flex-wrap gap-2">
                  <Input
                    className="max-w-xs"
                    type="email"
                    value={row.address}
                    aria-invalid={bad}
                    aria-label={t('newsletters.editor.recipients.addressLabel', { n: index + 1 })}
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
                    aria-label={t('newsletters.editor.recipients.removeAddress', { n: index + 1 })}
                    onClick={() => removeRow(index)}
                  >
                    <Trash2 />
                  </Button>
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={recipients.extraAddresses.length >= NEWSLETTER_EXTRA_ADDRESSES_MAX}
            onClick={addRow}
          >
            <Plus />
            {t('newsletters.editor.recipients.addAddress')}
          </Button>
        </div>
        <FieldError>{errors.recipients}</FieldError>
      </div>
      <RecipientsPanel
        newsletterId={newsletterId}
        recipients={recipients}
        onExclude={(userId) =>
          setRecipients({ excludeUserIds: [...recipients.excludeUserIds, userId] })
        }
        onInclude={(userId) =>
          setRecipients({ excludeUserIds: recipients.excludeUserIds.filter((id) => id !== userId) })
        }
        servers={scoped.map((s) => ({ id: s.id, name: s.name }))}
        staleScope={scopeMoved(savedServerIds, state.scope.serverIds)}
        onPreview={onPreview}
      />
    </EditorCard>
  );
}
