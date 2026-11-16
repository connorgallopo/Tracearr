import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { User } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getAvatarUrl } from '@/components/users/utils';
import { cn } from '@/lib/utils';

interface UserCellProps {
  /** The account row behind the person; null renders the muted em dash and no link. */
  serverUserId: string | null;
  username: string | null;
  /** The display name the identity carries, when it has one. */
  identityName?: string | null;
  /** The person's name when `username` is an account's and may not be it. */
  personName?: string;
  thumbUrl?: string | null;
  serverId?: string | null;
  /** `sm` for table rows, `md` for the pages that lead with a person. */
  size?: 'sm' | 'md';
  /** Muted facts on the handle's line, such as the email. */
  details?: string[];
  link?: boolean;
  trailing?: ReactNode;
  /** A removed account: the name reads as struck through. */
  muted?: boolean;
}

/** One person, wherever the app shows one: avatar, name, and the way to their page. */
export function UserCell({
  serverUserId,
  username,
  identityName,
  personName,
  thumbUrl,
  serverId,
  size = 'sm',
  details = [],
  link = true,
  trailing,
  muted,
}: UserCellProps) {
  const name = personName ?? identityName ?? username;
  if (name === null) return <span className="text-muted-foreground">—</span>;

  const small = size === 'sm';
  const avatarUrl = getAvatarUrl(serverId, thumbUrl, small ? 24 : 40);
  const subline = details.join(' · ');

  const body = (
    <>
      {/* The name is right beside it, so the initial is decoration rather than a second label. */}
      <Avatar aria-hidden className={small ? 'size-6' : 'size-10'}>
        {avatarUrl !== null && <AvatarImage src={avatarUrl} alt="" />}
        <AvatarFallback className={small ? 'text-[0.625rem] font-semibold' : 'text-sm font-medium'}>
          {identityName ? (
            identityName.slice(0, 1).toUpperCase()
          ) : (
            <User className={cn('text-muted-foreground', small ? 'size-3.5' : 'size-5')} />
          )}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0">
        <span
          className={cn(
            'block truncate font-medium',
            muted && 'text-muted-foreground line-through'
          )}
        >
          {name}
        </span>
        {subline !== '' && (
          <span className="text-muted-foreground block truncate text-xs">{subline}</span>
        )}
      </span>
    </>
  );

  const inner = cn('flex min-w-0 items-center', small ? 'gap-2' : 'gap-3');

  return (
    <div className="flex items-center gap-2">
      {link && serverUserId !== null ? (
        <Link
          to={`/users/${serverUserId}`}
          className={cn(inner, 'hover:underline')}
          // The row underneath usually opens something of its own.
          onClick={(event) => event.stopPropagation()}
        >
          {body}
        </Link>
      ) : (
        <span className={inner}>{body}</span>
      )}
      {trailing}
    </div>
  );
}
