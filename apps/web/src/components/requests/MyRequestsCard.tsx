import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Film, Inbox, Tv } from 'lucide-react';
import type { UserRequestEntry } from '@tracearr/shared';
import { Card, CardContent } from '@/components/ui/card';
import { SectionHeading } from '@/components/dashboard/SectionHeading';
import { RequestStatusBadge } from '@/components/requests/RequestStatusBadge';
import { useMyRequests, useRequestsConfigured } from '@/hooks/queries';
import { BASE_PATH } from '@/lib/basePath';
import { formatCompactAge } from '@/lib/dateFormat';

const PAGE_SIZE = 4;

function RequestRow({ request }: { request: UserRequestEntry }) {
  const { t } = useTranslation('pages');
  const { media } = request;
  const Icon = media.mediaType === 'movie' ? Film : Tv;
  const title = media.title ?? '';
  const meta = [
    media.year,
    t('dashboard.me.requests.requestedAgo', { age: formatCompactAge(request.requestedAt) }),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className="flex items-center gap-3 py-2">
      {media.posterUrl ? (
        <img
          src={`${BASE_PATH}${media.posterUrl}`}
          alt=""
          loading="lazy"
          className="aspect-[2/3] w-10 shrink-0 rounded-sm object-cover"
        />
      ) : (
        <div className="bg-muted text-muted-foreground flex aspect-[2/3] w-10 shrink-0 items-center justify-center rounded-sm">
          <Icon className="size-4" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {media.mediaId ? (
            <Link to={`/media/${media.mediaId}`} className="hover:underline">
              {title}
            </Link>
          ) : (
            title
          )}
        </div>
        <div className="text-muted-foreground truncate text-xs">{meta}</div>
      </div>
      <RequestStatusBadge status={request.status} deletedAt={request.deletedAt} />
    </li>
  );
}

export function MyRequestsCard({ className }: { className?: string }) {
  const { t } = useTranslation('pages');
  const configured = useRequestsConfigured().data?.configured ?? false;
  const { data } = useMyRequests({ page: 1, pageSize: PAGE_SIZE, enabled: configured });

  if (!configured || !data || data.total === 0) return null;

  const { availableThisWeek } = data.summary;

  return (
    <section className={className}>
      <SectionHeading
        icon={Inbox}
        title={t('dashboard.me.requests.title')}
        caption={
          availableThisWeek > 0
            ? t('dashboard.me.requests.availableThisWeek', { count: availableThisWeek })
            : undefined
        }
      >
        {data.total > PAGE_SIZE && (
          <Link to="/requests" className="text-primary ml-auto text-xs font-medium">
            {t('dashboard.me.requests.seeAll')} <span aria-hidden="true">→</span>
          </Link>
        )}
      </SectionHeading>
      <Card className="py-2">
        <CardContent>
          <ul className="divide-y">
            {data.data.map((request) => (
              <RequestRow key={request.id} request={request} />
            ))}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
