import { useTranslation } from 'react-i18next';
import type { ProfileFilterOption, UserRangeStats } from '@tracearr/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useProfileLabel, useProfileOptionLabel } from '@/components/sessions/useProfileLabel';
import { formatWatchTime } from '@/lib/dateFormat';

interface ProfilesCardProps {
  profiles: UserRangeStats['profiles'];
  /** The identity's profile options, which name a main profile by its account */
  options: ProfileFilterOption[];
  className?: string;
}

export function ProfilesCard({ profiles, options, className }: ProfilesCardProps) {
  const { t } = useTranslation('common');
  const profileLabel = useProfileLabel();
  const profileOptionLabel = useProfileOptionLabel();
  const optionById = new Map(options.map((option) => [option.id, option]));
  const topPlays = Math.max(...profiles.map((profile) => profile.plays));

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{t('labels.profiles')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5">
          {profiles.map((profile) => {
            const option = optionById.get(profile.profileId);
            return (
              <li key={profile.profileId} className="space-y-0.5 text-sm">
                <div className="flex gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {option ? profileOptionLabel(option) : profileLabel(profile)}
                  </span>
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
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
