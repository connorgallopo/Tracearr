import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Mail } from 'lucide-react';
import { isEmailAddress, type NewsletterRecipientPerson } from '@tracearr/shared';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { getAvatarUrl } from '@/components/users/utils';
import { useUpdateUserIdentity } from '@/hooks/queries';
import type { Translate } from '../newsletterFormat';
import type { PendingChange, RecipientEntry } from './recipientsView';

/** react-i18next's `t` overloads don't collapse to the plain `Translate` signature; this is the one cast. */
export function useTranslate(): { t: Translate; i18n: { language: string } } {
  const { t, i18n } = useTranslation(['settings', 'common']);
  return { t: t as Translate, i18n };
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

/** The row's title, which its controls are also named after; an extra address has only its address. */
export function entryName(entry: RecipientEntry, t: Translate): string {
  if (entry.kind !== 'recipient') return displayName(entry.person, t);
  return entry.row.serverUserId === null ? entry.row.address : displayName(entry.row, t);
}

/** The person behind every row: an avatar, the name linked to their user page, and an address or
 * account line underneath. An extra address (no account behind it) gets a Mail icon in place of
 * the avatar and no link. */
function PersonRow({
  person,
  address,
  addressFromUsername = false,
  badge,
  action,
  select,
  children,
}: {
  person: RecipientPerson;
  /** The resolved address, when this row has one; absent for a missing or excluded person. */
  address?: string | null;
  addressFromUsername?: boolean;
  badge?: ReactNode;
  action?: ReactNode;
  select?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useTranslate();
  const isExtra = person.serverUserId === null;
  const title = isExtra ? (address ?? '') : displayName(person, t);
  const avatarUrl = isExtra ? null : getAvatarUrl(person.serverId, person.thumbUrl, 40);
  const account =
    !isExtra && person.username !== null && person.serverName !== null
      ? t('newsletters.editor.recipients.account', {
          username: person.username,
          server: person.serverName,
        })
      : null;
  const addressPart =
    address && addressFromUsername
      ? `${address} · ${t('newsletters.editor.recipients.fromUsername')}`
      : address;
  const mutedLine = isExtra
    ? t('newsletters.editor.recipients.extraAddress')
    : addressPart
      ? account
        ? `${addressPart} · ${account}`
        : addressPart
      : account;

  return (
    <Item role="listitem" variant="outline" size="sm" aria-label={title}>
      {select}
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
  badge,
  onSaved,
}: {
  person: NewsletterRecipientPerson;
  badge: ReactNode;
  onSaved: () => void;
}) {
  const { t } = useTranslate();
  const identity = useUpdateUserIdentity();
  const [value, setValue] = useState('');
  const label = displayName(person, t);
  return (
    <PersonRow person={person} badge={badge}>
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
          disabled={!isEmailAddress(value.trim()) || identity.isPending}
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

export interface EntryActions {
  onExclude: (userIds: string[]) => void;
  onInclude: (userIds: string[]) => void;
  onContactSaved: () => void;
}

export function EntryRow({
  entry,
  pending,
  actions,
  select,
}: {
  entry: RecipientEntry;
  pending: PendingChange;
  actions: EntryActions;
  select?: ReactNode;
}) {
  const { t } = useTranslate();
  const name = entryName(entry, t);
  const pendingBadge =
    pending === null ? null : (
      <Badge variant="outline">
        {t(
          pending === 'excluded'
            ? 'newsletters.editor.recipients.excludedAfterSave'
            : 'newsletters.editor.recipients.includedAfterSave'
        )}
      </Badge>
    );
  const moveButton = (move: 'exclude' | 'include', userId: string) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={t(`newsletters.editor.recipients.${move}`, { name })}
      onClick={() => (move === 'exclude' ? actions.onExclude : actions.onInclude)([userId])}
    >
      {t(`newsletters.editor.recipients.${move}Action`)}
    </Button>
  );

  switch (entry.kind) {
    case 'recipient': {
      const { row } = entry;
      return (
        <PersonRow
          person={row}
          address={row.address}
          addressFromUsername={row.addressFromUsername}
          select={select}
          badge={
            <>
              {row.newSinceLastSend && (
                <Badge variant="secondary">
                  {t('newsletters.editor.recipients.newSinceLastSend')}
                </Badge>
              )}
              {row.suppressed && (
                <Badge variant="warning">{t('newsletters.editor.recipients.suppressed')}</Badge>
              )}
              {pendingBadge}
            </>
          }
          action={row.userId !== null && moveButton('exclude', row.userId)}
        />
      );
    }
    case 'missing':
      return (
        <MissingRow person={entry.person} badge={pendingBadge} onSaved={actions.onContactSaved} />
      );
    case 'excluded': {
      const { person } = entry;
      return (
        <PersonRow
          person={person}
          select={select}
          badge={
            pendingBadge ?? (
              <Badge variant={person.reason === 'excluded' ? 'outline' : 'warning'}>
                {t(`newsletters.editor.recipients.reasons.${person.reason}`)}
              </Badge>
            )
          }
          action={person.reason === 'excluded' && moveButton('include', person.userId)}
        />
      );
    }
  }
}
