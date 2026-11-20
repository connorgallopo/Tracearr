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
          'ring-background absolute -right-0.5 -bottom-0.5 size-[40%] ring-2',
          profile.removed && 'opacity-50 grayscale'
        )}
      >
        <AvatarImage src={getAvatarUrl(serverId, profile.thumbUrl, 24) ?? undefined} alt="" />
        <AvatarFallback className="text-[0.5rem] leading-none">
          {profile.name[0]?.toUpperCase() ?? '?'}
        </AvatarFallback>
      </Avatar>
    </span>
  );
}
