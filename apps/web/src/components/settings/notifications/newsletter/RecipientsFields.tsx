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
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemGroup } from '@/components/ui/item';
import { Switch } from '@/components/ui/switch';
import { RecipientsPanel } from './RecipientsPanel';
import type { FieldsetProps } from './newsletterForm';

const address = z.email();

export function RecipientsFields({
  state,
  onChange,
  errors,
  newsletterId,
}: FieldsetProps & { newsletterId: string | null }) {
  const { t } = useTranslation('settings');
  const { recipients } = state;
  const setRecipients = (patch: Partial<typeof recipients>) =>
    onChange({ recipients: { ...recipients, ...patch } });
  const setRow = (index: number, patch: { address?: string; name?: string }) =>
    setRecipients({
      extraAddresses: recipients.extraAddresses.map((row, i) =>
        i === index ? { ...row, ...patch } : row
      ),
    });

  return (
    <FieldSet>
      <FieldLegend>{t('newsletters.editor.recipients.title')}</FieldLegend>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="newsletter-members">
            {t('newsletters.editor.recipients.members')}
          </FieldLabel>
          <FieldDescription>{t('newsletters.editor.recipients.membersHelp')}</FieldDescription>
          <FieldDescription>{t('newsletters.editor.recipients.ownerNote')}</FieldDescription>
        </FieldContent>
        <Switch
          id="newsletter-members"
          checked={recipients.members}
          onCheckedChange={(members) => setRecipients({ members })}
          aria-label={t('newsletters.editor.recipients.members')}
        />
      </Field>
      <div className="flex flex-col gap-2">
        <FieldLabel>{t('newsletters.editor.recipients.extraAddresses')}</FieldLabel>
        <ItemGroup className="gap-1">
          {recipients.extraAddresses.map((row, index) => {
            const bad = row.address !== '' && !address.safeParse(row.address).success;
            return (
              <Item key={index} role="listitem" variant="outline" size="sm" className="flex-wrap">
                <ItemContent className="flex-row flex-wrap gap-2">
                  <Input
                    className="max-w-xs"
                    type="email"
                    value={row.address}
                    aria-invalid={bad}
                    aria-label={t('newsletters.editor.recipients.addressLabel', { n: index + 1 })}
                    placeholder="someone@example.com"
                    onChange={(event) => setRow(index, { address: event.target.value })}
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
                    onClick={() =>
                      setRecipients({
                        extraAddresses: recipients.extraAddresses.filter((_, i) => i !== index),
                      })
                    }
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
            onClick={() =>
              setRecipients({ extraAddresses: [...recipients.extraAddresses, { address: '' }] })
            }
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
      />
    </FieldSet>
  );
}
