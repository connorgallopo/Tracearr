import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ExternalLink, UserX } from 'lucide-react';
import type {
  NewsletterExcludedPerson,
  NewsletterRecipientPerson,
  NewsletterRecipients,
  NewsletterRecipientsView,
  NewsletterResolvedRecipient,
} from '@tracearr/shared';
import { z } from 'zod';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { EmptyState } from '@/components/ui/empty-state';
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

interface PendingPerson extends NewsletterExcludedPerson {
  /** True when the change waits for Save: excluded here but not on the server, or the reverse. */
  pending: boolean;
}

export interface RecipientPartition {
  receive: NewsletterResolvedRecipient[];
  /** On the suppression list; the send records them as suppressed and mails nothing. */
  suppressed: NewsletterResolvedRecipient[];
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
  const kept = view.recipients.filter((r) => r.userId === null || !local.has(r.userId));
  const receive = kept.filter((r) => !r.suppressed);
  const suppressed = kept.filter((r) => r.suppressed);
  const excluded: PendingPerson[] = [
    ...view.excluded
      .filter((p) => p.reason !== 'excluded' || local.has(p.userId))
      .map((p) => ({ ...p, pending: false })),
    ...view.recipients
      .filter(
        (r): r is NewsletterResolvedRecipient & { userId: string; serverUserId: string } =>
          r.userId !== null && r.serverUserId !== null && local.has(r.userId)
      )
      .map((r) => ({
        userId: r.userId,
        serverUserId: r.serverUserId,
        name: r.name,
        reason: 'excluded' as const,
        pending: true,
      })),
  ];
  const included = view.excluded
    .filter((p) => p.reason === 'excluded' && !local.has(p.userId))
    .map((p) => ({ ...p, pending: true }));
  return { receive, suppressed, missing: view.missing, excluded, included };
}

const address = z.email();

/** What the send reaches with Members off: the typed addresses, normalized and deduped, the first name winning. */
export function extraRecipients(
  extraAddresses: readonly { address: string; name?: string }[]
): { address: string; name: string | null }[] {
  const seen = new Map<string, string | null>();
  for (const row of extraAddresses) {
    const normalized = row.address.trim().toLowerCase();
    if (seen.has(normalized) || !address.safeParse(normalized).success) continue;
    seen.set(normalized, row.name ?? null);
  }
  return [...seen].map(([addr, name]) => ({ address: addr, name }));
}

/** One row shape shared by the receive, included and excluded lists: a label, an optional
 * badge and description, and an optional trailing action. */
function RecipientRow({
  label,
  description,
  badge,
  action,
}: {
  label: string;
  description?: string | null;
  badge?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Item role="listitem" variant="outline" size="sm" aria-label={label}>
      <ItemContent>
        <ItemTitle>
          {label}
          {badge}
        </ItemTitle>
        {description && <ItemDescription>{description}</ItemDescription>}
      </ItemContent>
      {action && <ItemActions>{action}</ItemActions>}
    </Item>
  );
}

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
  recipients,
  onExclude,
  onInclude,
}: {
  newsletterId: string | null;
  recipients: NewsletterRecipients;
  onExclude: (userId: string) => void;
  onInclude: (userId: string) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const { members, extraAddresses, excludeUserIds } = recipients;
  // With Members off the server has nothing to add: the list is the typed addresses.
  const { data, isLoading, isError, error, refetch } = useNewsletterRecipients(
    members && newsletterId ? newsletterId : undefined
  );
  const [open, setOpen] = useState(false);

  if (!members) {
    const extras = extraRecipients(extraAddresses);
    return (
      <div className="flex flex-col gap-2">
        <FieldDescription>{t('newsletters.editor.recipients.membersOff')}</FieldDescription>
        <p className="text-sm font-medium">
          {t('newsletters.editor.recipients.willReceive', { count: extras.length })}
        </p>
        <ItemGroup className="gap-1">
          {extras.map((extra) => (
            <RecipientRow key={extra.address} label={extra.address} description={extra.name} />
          ))}
        </ItemGroup>
      </div>
    );
  }
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

  const { receive, suppressed, missing, excluded, included } = partitionRecipients(
    data,
    excludeUserIds
  );
  const personName = (p: NewsletterRecipientPerson) => p.name ?? p.serverUserId;
  const excludeAction = (r: NewsletterResolvedRecipient) => {
    const userId = r.userId;
    if (userId === null) return null;
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={t('newsletters.editor.recipients.exclude', { name: r.name ?? r.address })}
        onClick={() => onExclude(userId)}
      >
        {t('newsletters.editor.recipients.excludeAction')}
      </Button>
    );
  };

  if (
    receive.length + suppressed.length + missing.length + excluded.length + included.length ===
    0
  ) {
    return (
      <EmptyState
        icon={UserX}
        title={t('newsletters.editor.recipients.emptyTitle')}
        description={t('newsletters.editor.recipients.emptyDescription')}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium">
          {t('newsletters.editor.recipients.willReceive', { count: receive.length })}
        </p>
        <ItemGroup className="mt-2 gap-1">
          {receive.map((r) => (
            <RecipientRow
              key={r.address}
              label={r.address}
              description={r.name}
              action={excludeAction(r)}
            />
          ))}
          {included.map((p) => (
            <RecipientRow
              key={p.userId}
              label={personName(p)}
              badge={
                <Badge variant="outline">
                  {t('newsletters.editor.recipients.includedAfterSave')}
                </Badge>
              }
              action={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('newsletters.editor.recipients.exclude', { name: personName(p) })}
                  onClick={() => onExclude(p.userId)}
                >
                  {t('newsletters.editor.recipients.excludeAction')}
                </Button>
              }
            />
          ))}
        </ItemGroup>
      </div>
      {suppressed.length > 0 && (
        <div>
          <p className="text-sm font-medium">
            {t('newsletters.editor.recipients.suppressedHeading', { count: suppressed.length })}
          </p>
          <FieldDescription>{t('newsletters.editor.recipients.suppressedHelp')}</FieldDescription>
          <ItemGroup className="mt-2 gap-1">
            {suppressed.map((r) => (
              <RecipientRow
                key={r.address}
                label={r.address}
                description={r.name}
                badge={
                  <Badge variant="warning">{t('newsletters.editor.recipients.suppressed')}</Badge>
                }
                action={excludeAction(r)}
              />
            ))}
          </ItemGroup>
        </div>
      )}
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
          <Button type="button" variant="ghost" size="sm">
            {open ? <ChevronDown /> : <ChevronRight />}
            {t('newsletters.editor.recipients.excludedCount', { count: excluded.length })}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ItemGroup className="mt-2 gap-1">
            {excluded.map((p) => (
              <RecipientRow
                key={p.userId}
                label={personName(p)}
                badge={
                  p.reason === 'banned' ? (
                    <Badge variant="warning">
                      {t('newsletters.editor.recipients.reasons.banned')}
                    </Badge>
                  ) : p.reason === 'pending' ? (
                    <Badge variant="warning">
                      {t('newsletters.editor.recipients.reasons.pending')}
                    </Badge>
                  ) : (
                    p.pending && (
                      <Badge variant="outline">
                        {t('newsletters.editor.recipients.excludedAfterSave')}
                      </Badge>
                    )
                  )
                }
                action={
                  p.reason === 'excluded' && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t('newsletters.editor.recipients.include', {
                        name: personName(p),
                      })}
                      onClick={() => onInclude(p.userId)}
                    >
                      {t('newsletters.editor.recipients.includeAction')}
                    </Button>
                  )
                }
              />
            ))}
          </ItemGroup>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
