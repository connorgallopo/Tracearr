import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Mail, UserX } from 'lucide-react';
import type {
  NewsletterExcludedPerson,
  NewsletterRecipientPerson,
  NewsletterRecipients,
  NewsletterRecipientsView,
  NewsletterResolvedRecipient,
} from '@tracearr/shared';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { getAvatarUrl } from '@/components/users/utils';
import { newsletterKeys, useNewsletterRecipients, useUpdateUserIdentity } from '@/hooks/queries';
import type { Translate } from '../newsletterFormat';

/** react-i18next's `t` overloads don't collapse to the plain `Translate` signature; this is the one cast. */
function useTranslate(): Translate {
  const { t } = useTranslation(['settings', 'common']);
  return t as Translate;
}

/** The fields every recipient list row carries, whether or not an address or badge applies. */
interface RecipientPerson {
  serverUserId: string | null;
  name: string | null;
  username: string | null;
  serverId: string | null;
  serverName: string | null;
  thumbUrl: string | null;
}

/** The name the row leads with; falls back through the account's own username before the generic label. */
function displayName(person: RecipientPerson, t: Translate): string {
  return person.name ?? person.username ?? t('newsletters.editor.recipients.unknownMember');
}

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
        username: r.username,
        serverId: r.serverId ?? '',
        serverName: r.serverName ?? '',
        thumbUrl: r.thumbUrl,
        serverIds: r.serverIds,
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
  const seen = new Map<string, { address: string; name: string | null }>();
  for (const row of extraAddresses) {
    const typed = row.address.trim();
    const key = typed.toLowerCase();
    if (seen.has(key) || !address.safeParse(key).success) continue;
    seen.set(key, { address: typed, name: row.name ?? null });
  }
  return [...seen.values()];
}

/** The Members-off preview: a typed address with its optional name, no account behind it. */
function RecipientRow({ label, description }: { label: string; description?: string | null }) {
  return (
    <Item role="listitem" variant="outline" size="sm" aria-label={label}>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        {description && <ItemDescription>{description}</ItemDescription>}
      </ItemContent>
    </Item>
  );
}

/** The person behind every receive, suppressed, missing and excluded row: an avatar, the name
 * linked to their user page, and an address or account line underneath. An extra address (no
 * account behind it) gets a Mail icon in place of the avatar and no link. */
function PersonRow({
  person,
  address: recipientAddress,
  badge,
  action,
  children,
}: {
  person: RecipientPerson;
  /** The resolved address, when this row has one; absent for a missing or excluded person. */
  address?: string | null;
  badge?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const t = useTranslate();
  const isExtra = person.serverUserId === null;
  const title = isExtra ? (recipientAddress ?? '') : displayName(person, t);
  const avatarUrl = isExtra ? null : getAvatarUrl(person.serverId, person.thumbUrl, 40);
  const account =
    !isExtra && person.username !== null && person.serverName !== null
      ? t('newsletters.editor.recipients.account', {
          username: person.username,
          server: person.serverName,
        })
      : null;
  const mutedLine = isExtra
    ? t('newsletters.editor.recipients.extraAddress')
    : recipientAddress
      ? account
        ? `${recipientAddress} · ${account}`
        : recipientAddress
      : account;

  return (
    <Item role="listitem" variant="outline" size="sm" aria-label={title}>
      <ItemMedia>
        <Avatar className="size-10">
          {isExtra ? (
            <AvatarFallback>
              <Mail className="text-muted-foreground size-5" />
            </AvatarFallback>
          ) : (
            <>
              {avatarUrl !== null && <AvatarImage src={avatarUrl} alt="" />}
              <AvatarFallback className="text-sm font-medium">
                {title.slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </>
          )}
        </Avatar>
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {isExtra ? (
            title
          ) : (
            <Link
              to={`/users/${person.serverUserId}`}
              aria-label={t('newsletters.editor.recipients.openUserPage', { name: title })}
              className="hover:underline"
            >
              {title}
            </Link>
          )}
          {badge}
        </ItemTitle>
        {mutedLine && <ItemDescription>{mutedLine}</ItemDescription>}
        {children}
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
  const t = useTranslate();
  const identity = useUpdateUserIdentity();
  const [value, setValue] = useState('');
  const label = displayName(person, t);
  const valid = address.safeParse(value.trim()).success;
  return (
    <PersonRow person={person}>
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
      </div>
    </PersonRow>
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
  const t = useTranslate();
  const { members, extraAddresses, excludeUserIds } = recipients;
  // With Members off the server has nothing to add: the list is the typed addresses.
  const { data, isLoading, isError, error, refetch } = useNewsletterRecipients(
    members && newsletterId ? newsletterId : undefined
  );
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const noRecipients = (
    <EmptyState
      icon={UserX}
      title={t('newsletters.editor.recipients.emptyTitle')}
      description={t('newsletters.editor.recipients.emptyDescription')}
    />
  );

  if (!members) {
    const extras = extraRecipients(extraAddresses);
    if (extras.length === 0) return noRecipients;

    // A saved view already in the cache tells us who's suppressed without a fetch of our own.
    const cachedView = newsletterId
      ? queryClient.getQueryData<NewsletterRecipientsView>(newsletterKeys.recipients(newsletterId))
      : undefined;
    const suppressedAddresses = new Set(
      (cachedView?.recipients ?? []).filter((r) => r.suppressed).map((r) => r.address.toLowerCase())
    );
    const suppressedCount = extras.filter((extra) =>
      suppressedAddresses.has(extra.address.toLowerCase())
    ).length;

    return (
      <div className="flex flex-col gap-2">
        <FieldDescription>
          {suppressedCount > 0
            ? t('newsletters.editor.recipients.membersOffSuppressed', { count: suppressedCount })
            : t('newsletters.editor.recipients.membersOff')}
        </FieldDescription>
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
  const personName = (p: NewsletterRecipientPerson) => displayName(p, t);
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
    return noRecipients;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium">
          {t('newsletters.editor.recipients.willReceive', { count: receive.length })}
        </p>
        <ItemGroup className="mt-2 gap-1">
          {receive.map((r) => (
            <PersonRow key={r.address} person={r} address={r.address} action={excludeAction(r)} />
          ))}
          {included.map((p) => (
            <PersonRow
              key={p.userId}
              person={p}
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
              <PersonRow
                key={r.address}
                person={r}
                address={r.address}
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
              <PersonRow
                key={p.userId}
                person={p}
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
