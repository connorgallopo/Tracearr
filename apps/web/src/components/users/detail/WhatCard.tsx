import { useTranslation } from 'react-i18next';
import type { UserRangeStats } from '@tracearr/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type WhatStats = Pick<UserRangeStats, 'mediaTypeSplit' | 'topGenres'>;

const MEDIA_TYPES = [
  { key: 'movie', labelKey: 'common:media.movie_plural', className: 'bg-media-movie' },
  { key: 'episode', labelKey: 'common:media.episode_plural', className: 'bg-media-show' },
  { key: 'track', labelKey: 'common:media.track_plural', className: 'bg-media-music' },
  { key: 'other', labelKey: 'pages:userDetail.overview.otherMedia', className: 'bg-media-other' },
] as const;

export function WhatCard({ stats }: { stats: WhatStats | undefined }) {
  const { t } = useTranslation(['pages', 'common']);
  const split = stats?.mediaTypeSplit;
  const total = split ? split.movie + split.episode + split.track + split.other : 0;
  const genres = stats?.topGenres ?? [];
  const topGenrePlays = genres[0]?.plays ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('pages:userDetail.overview.what')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {split && total > 0 ? (
          <div className="space-y-2">
            <div className="bg-muted flex h-2.5 overflow-hidden rounded-full">
              {MEDIA_TYPES.map(({ key, className }) =>
                split[key] > 0 ? (
                  <div
                    key={key}
                    className={className}
                    style={{ width: `${(split[key] / total) * 100}%` }}
                  />
                ) : null
              )}
            </div>
            <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {MEDIA_TYPES.filter(({ key }) => split[key] > 0).map(
                ({ key, labelKey, className }) => (
                  <li key={key} className="flex items-center gap-1.5">
                    <span className={`${className} size-2 rounded-full`} />
                    {t(labelKey)}{' '}
                    <span className="text-foreground tabular-nums">
                      {Math.round((split[key] / total) * 100)}%
                    </span>
                  </li>
                )
              )}
            </ul>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">{t('common:empty.noData')}</p>
        )}

        {genres.length > 0 && (
          <ul className="space-y-1.5">
            {genres.map((genre) => (
              <li key={genre.genre} className="space-y-0.5 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="truncate">{genre.genre}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {t('common:count.play', { count: genre.plays })}
                  </span>
                </div>
                <div className="bg-muted h-1 overflow-hidden rounded-full">
                  <div
                    className="bg-primary h-full"
                    style={{
                      width: `${topGenrePlays > 0 ? (genre.plays / topGenrePlays) * 100 : 0}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
