import { cn } from '@/lib/utils';
import { useProfileLabel } from './useProfileLabel';

interface NameWithProfileProps {
  name: string;
  profileName: string | null;
  profileRemoved: boolean;
  className?: string;
}

export function NameWithProfile({
  name,
  profileName,
  profileRemoved,
  className,
}: NameWithProfileProps) {
  const profileLabel = useProfileLabel();
  const profile = profileName ? profileLabel({ name: profileName, removed: profileRemoved }) : null;

  return (
    <span className={cn('truncate', className)} title={profile ? `${name} · ${profile}` : name}>
      {name}
      {profile && <span className="text-muted-foreground font-normal"> · {profile}</span>}
    </span>
  );
}
