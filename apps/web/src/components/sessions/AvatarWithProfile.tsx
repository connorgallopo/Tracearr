import type { ReactNode } from 'react';
import type { NonMainProfile } from '@tracearr/shared';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getAvatarUrl } from '@/components/users/utils';
import { cn } from '@/lib/utils';
import { useProfileLabel } from './useProfileLabel';

interface AvatarWithProfileProps {
  serverId: string;
  profile: NonMainProfile | undefined;
  /** The account's avatar */
  children: ReactNode;
}

/** The account's avatar, with the profile that played over its bottom-right when it is not the main one */
export function AvatarWithProfile({ serverId, profile, children }: AvatarWithProfileProps) {
  const profileLabel = useProfileLabel();
  if (!profile) return children;

  const label = profileLabel(profile);
  return (
    <span className="relative inline-flex shrink-0">
      {children}
      <Avatar
        role="img"
        aria-label={label}
        title={label}
        className={cn(
          'ring-background @container absolute -right-[20%] -bottom-[20%] size-[56%] ring-2',
          profile.removed && 'opacity-50 grayscale'
        )}
      >
        <AvatarImage src={getAvatarUrl(serverId, profile.thumbUrl, 24) ?? undefined} alt="" />
        <AvatarFallback className="text-[70cqi] leading-none">
          {profile.name[0]?.toUpperCase() ?? '?'}
        </AvatarFallback>
      </Avatar>
    </span>
  );
}
