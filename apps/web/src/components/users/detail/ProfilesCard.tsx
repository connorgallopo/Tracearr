import { useTranslation } from 'react-i18next';
import type { UserRangeStats } from '@tracearr/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useProfileOptionLabel } from '@/components/sessions/useProfileLabel';
import { formatWatchTime } from '@/lib/dateFormat';

interface ProfilesCardProps {
  profiles: UserRangeStats['profiles'];
  className?: string;
}

export function ProfilesCard({ profiles, className }: ProfilesCardProps) {
  const { t } = useTranslation('common');
  const profileOptionLabel = useProfileOptionLabel();
  const topPlays = Math.max(...profiles.map((profile) => profile.plays));

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{t('labels.profiles')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5">
          {profiles.map((profile) => (
            <li key={profile.profileId} className="space-y-0.5 text-sm">
              <div className="flex gap-2">
                <span className="min-w-0 flex-1 truncate">{profileOptionLabel(profile)}</span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {t('count.play', { count: profile.plays })}
                </span>
                <span className="text-muted-foreground min-w-16 shrink-0 text-right text-xs tabular-nums">
                  {formatWatchTime(profile.watchMs)}
                </span>
              </div>
              <div className="bg-muted h-1 overflow-hidden rounded-full">
                <div
                  className="bg-primary h-full"
                  style={{ width: `${(profile.plays / topPlays) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
