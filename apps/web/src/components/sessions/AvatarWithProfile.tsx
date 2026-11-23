import type { ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import type { NonMainProfile } from '@tracearr/shared';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getAvatarUrl } from '@/components/users/utils';
import { cn } from '@/lib/utils';
import { useProfileLabel } from './useProfileLabel';

// Two-letter initials reach toward the avatar's bottom-right corner, so beside them the
// badge is smaller and its inner edge stays clear of the letters. Sized by width alone so
// it stays round over a poster taller than it is wide.
const profileBadgeVariants = cva(
  'ring-background @container absolute aspect-square h-auto ring-2',
  {
    variants: {
      initials: {
        one: '-right-[20%] -bottom-[20%] w-[56%]',
        two: '-right-[15%] -bottom-[15%] w-[44%]',
      },
    },
    defaultVariants: { initials: 'one' },
  }
);

interface AvatarWithProfileProps extends VariantProps<typeof profileBadgeVariants> {
  serverId: string;
  profile: NonMainProfile | undefined;
  /** The account's avatar */
  children: ReactNode;
}

/** The account's avatar, with the profile that played over its bottom-right when it is not the main one */
export function AvatarWithProfile({
  serverId,
  profile,
  initials,
  children,
}: AvatarWithProfileProps) {
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
          profileBadgeVariants({ initials }),
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
