import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import type {
  NewsletterRecipientPerson,
  NewsletterRecipientsView,
  NewsletterResolvedRecipient,
} from '@tracearr/shared';
import { z } from 'zod';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { useNewsletterRecipients, useUpdateUserIdentity } from '@/hooks/queries';

interface PendingPerson extends NewsletterRecipientPerson {
  /** True when the change waits for Save: excluded here but not on the server, or the reverse. */
  pending: boolean;
}

export interface RecipientPartition {
  receive: NewsletterResolvedRecipient[];
  missing: NewsletterRecipientPerson[];
  excluded: PendingPerson[];
  /** Excluded on the server, included here; they return to the list once saved. */
  included: PendingPerson[];
}

/** The saved view plus the form's unsaved exclusions, so the lists answer what the next save will do. */
export function partitionRecipients(
  view: NewsletterRecipientsView,
  excludeUserIds: readonly string[]
): RecipientPartition {
  const local = new Set(excludeUserIds);
  const receive = view.recipients.filter((r) => r.userId === null || !local.has(r.userId));
  const excluded: PendingPerson[] = [
    ...view.excluded.filter((p) => local.has(p.userId)).map((p) => ({ ...p, pending: false })),
    ...view.recipients
      .filter(
        (r): r is NewsletterResolvedRecipient & { userId: string; serverUserId: string } =>
          r.userId !== null && r.serverUserId !== null && local.has(r.userId)
      )
      .map((r) => ({
        userId: r.userId,
        serverUserId: r.serverUserId,
        name: r.name,
        pending: true,
      })),
  ];
  const included = view.excluded
    .filter((p) => !local.has(p.userId))
    .map((p) => ({ ...p, pending: true }));
  return { receive, missing: view.missing, excluded, included };
}

const address = z.email();

function MissingRow({
  person,
  onSaved,
}: {
  person: NewsletterRecipientPerson;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const identity = useUpdateUserIdentity();
  const [value, setValue] = useState('');
  const label = person.name ?? person.serverUserId;
  const valid = address.safeParse(value.trim()).success;
  return (
    <Item role="listitem" variant="outline" size="sm" aria-label={label}>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="max-w-xs"
            type="email"
            value={value}
            aria-label={t('newsletters.editor.recipients.contactEmailFor', { name: label })}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!valid || identity.isPending}
            aria-label={t('newsletters.editor.recipients.saveEmail', { name: label })}
            onClick={() =>
              identity.mutate(
                { id: person.serverUserId, data: { contactEmail: value.trim() } },
                { onSuccess: onSaved }
              )
            }
          >
            {t('common:actions.save')}
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link
              to={`/users/${person.serverUserId}`}
              aria-label={t('newsletters.editor.recipients.openUser')}
            >
              <ExternalLink />
            </Link>
          </Button>
        </div>
      </ItemContent>
    </Item>
  );
}

export function RecipientsPanel({
  newsletterId,
  excludeUserIds,
  onExclude,
  onInclude,
}: {
  newsletterId: string | null;
  excludeUserIds: readonly string[];
  onExclude: (userId: string) => void;
  onInclude: (userId: string) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const { data, isLoading, isError, error, refetch } = useNewsletterRecipients(
    newsletterId ?? undefined
  );
  const [open, setOpen] = useState(false);

  if (!newsletterId)
    return <FieldDescription>{t('newsletters.editor.recipients.saveFirst')}</FieldDescription>;
  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (isError || !data) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {error?.message ?? t('newsletters.editor.recipients.loadFailed')}
        </AlertDescription>
      </Alert>
    );
  }

  const { receive, missing, excluded, included } = partitionRecipients(data, excludeUserIds);
  const personName = (p: NewsletterRecipientPerson) => p.name ?? p.serverUserId;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium">
          {t('newsletters.editor.recipients.willReceive', { count: receive.length })}
        </p>
        <ItemGroup className="mt-2 gap-1">
          {receive.map((r) => (
            <Item
              key={r.address}
              role="listitem"
              variant="outline"
              size="sm"
              aria-label={r.address}
            >
              <ItemContent>
                <ItemTitle>
                  {r.address}
                  {r.suppressed && (
                    <Badge variant="warning">{t('newsletters.editor.recipients.suppressed')}</Badge>
                  )}
                  {r.userId !== null && excludeUserIds.includes(r.userId) && (
                    <Badge variant="outline">
                      {t('newsletters.editor.recipients.excludedAfterSave')}
                    </Badge>
                  )}
                </ItemTitle>
                {r.name && <ItemDescription>{r.name}</ItemDescription>}
              </ItemContent>
              {r.userId !== null && !excludeUserIds.includes(r.userId) && (
                <ItemActions>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('newsletters.editor.recipients.exclude', {
                      name: r.name ?? r.address,
                    })}
                    onClick={() => onExclude(r.userId as string)}
                  >
                    {t('newsletters.editor.recipients.excludeAction')}
                  </Button>
                </ItemActions>
              )}
            </Item>
          ))}
          {included.map((p) => (
            <Item
              key={p.userId}
              role="listitem"
              variant="outline"
              size="sm"
              aria-label={personName(p)}
            >
              <ItemContent>
                <ItemTitle>
                  {personName(p)}
                  <Badge variant="outline">
                    {t('newsletters.editor.recipients.includedAfterSave')}
                  </Badge>
                </ItemTitle>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </div>
      <div>
        <p className="text-sm font-medium">
          {t('newsletters.editor.recipients.noAddress', { count: missing.length })}
        </p>
        <FieldDescription>{t('newsletters.editor.recipients.noAddressHelp')}</FieldDescription>
        <ItemGroup className="mt-2 gap-1">
          {missing.map((p) => (
            <MissingRow key={p.userId} person={p} onSaved={() => void refetch()} />
          ))}
        </ItemGroup>
      </div>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" aria-expanded={open}>
            {open ? <ChevronDown /> : <ChevronRight />}
            {t('newsletters.editor.recipients.excludedCount', { count: excluded.length })}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ItemGroup className="mt-2 gap-1">
            {excluded.map((p) => (
              <Item
                key={p.userId}
                role="listitem"
                variant="outline"
                size="sm"
                aria-label={personName(p)}
              >
                <ItemContent>
                  <ItemTitle>
                    {personName(p)}
                    {p.pending && (
                      <Badge variant="outline">
                        {t('newsletters.editor.recipients.excludedAfterSave')}
                      </Badge>
                    )}
                  </ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('newsletters.editor.recipients.include', { name: personName(p) })}
                    onClick={() => onInclude(p.userId)}
                  >
                    {t('newsletters.editor.recipients.includeAction')}
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
