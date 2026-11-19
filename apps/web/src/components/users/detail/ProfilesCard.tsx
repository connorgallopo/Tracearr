import { useTranslation } from 'react-i18next';
import type { UserRangeStats } from '@tracearr/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useProfileLabel } from '@/components/sessions/useProfileLabel';
import { formatWatchTime } from '@/lib/dateFormat';

export function ProfilesCard({ profiles }: { profiles: UserRangeStats['profiles'] }) {
  const { t } = useTranslation('common');
  const profileLabel = useProfileLabel();
  const topPlays = Math.max(...profiles.map((profile) => profile.plays));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('labels.profiles')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5">
          {profiles.map((profile) => (
            <li key={profile.profileId} className="space-y-0.5 text-sm">
              <div className="flex justify-between gap-2">
                <span className="truncate">{profileLabel(profile)}</span>
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {t('count.play', { count: profile.plays })} · {formatWatchTime(profile.watchMs)}
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
