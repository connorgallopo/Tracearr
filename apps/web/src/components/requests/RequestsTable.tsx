import { format } from 'date-fns';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Film, ListPlus, Sparkles, Tv } from 'lucide-react';
import type {
  MediaRequestEntry,
  MediaRequestStatus,
  RequestSeason,
  UserRequestEntry,
} from '@tracearr/shared';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TableRowSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineErrorState } from '@/components/library/ErrorState';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { UserCell } from '@/components/users/UserCell';
import { WatchedBadge } from '@/components/media-browse/WatchedBadge';
import { RequestStatusBadge } from '@/components/requests/RequestStatusBadge';
import { formatSeasons, formatWait, type Translate } from '@/components/requests/format';
import { cn } from '@/lib/utils';

const COLUMN_COUNT = 6;

interface RequestsTableCommonProps {
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  emptyTitle: string;
}

type RequestsTableProps = RequestsTableCommonProps &
  ({ subject: 'media'; rows: MediaRequestEntry[] } | { subject: 'user'; rows: UserRequestEntry[] });

/** The fields shared by both row shapes, driving every column but the leading one. */
interface RequestRowCommon {
  id: string;
  status: MediaRequestStatus;
  deletedAt: string | null;
  requestedAt: string;
  waitMs: number | null;
  seasons: RequestSeason[] | null;
  watchedState: MediaRequestEntry['watchedState'];
}

function RequestFlags({ is4k, isAutoRequest }: { is4k: boolean; isAutoRequest: boolean }) {
  const { t } = useTranslation('pages');
  if (!is4k && !isAutoRequest) return null;

  return (
    <TooltipProvider delayDuration={100}>
      <span className="inline-flex items-center gap-1">
        {is4k && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Sparkles
                className="text-muted-foreground size-3.5"
                aria-label={t('requests.flags.fourK')}
              />
            </TooltipTrigger>
            <TooltipContent>{t('requests.flags.fourK')}</TooltipContent>
          </Tooltip>
        )}
        {isAutoRequest && (
          <Tooltip>
            <TooltipTrigger asChild>
              <ListPlus
                className="text-muted-foreground size-3.5"
                aria-label={t('requests.flags.auto')}
              />
            </TooltipTrigger>
            <TooltipContent>{t('requests.flags.auto')}</TooltipContent>
          </Tooltip>
        )}
      </span>
    </TooltipProvider>
  );
}

function MediaLeadingCell({ row }: { row: MediaRequestEntry }) {
  const { t } = useTranslation('pages');
  const { requester } = row;

  if (requester.serverUserId === null) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{t('requests.unattributed')}</span>
        <RequestFlags is4k={row.is4k} isAutoRequest={row.isAutoRequest} />
      </div>
    );
  }

  return (
    <UserCell
      serverUserId={requester.serverUserId}
      username={requester.username}
      identityName={requester.identityName}
      thumbUrl={requester.thumb}
      serverId={requester.serverId}
      trailing={<RequestFlags is4k={row.is4k} isAutoRequest={row.isAutoRequest} />}
    />
  );
}

function UserLeadingCell({ row }: { row: UserRequestEntry }) {
  const Icon = row.media.mediaType === 'movie' ? Film : Tv;
  const title = row.media.title ?? '—';

  return (
    <div className="flex items-center gap-2">
      <Icon className="text-muted-foreground size-4 shrink-0" />
      {row.media.mediaId !== null ? (
        <Link to={`/media/${row.media.mediaId}`} className="truncate font-medium hover:underline">
          {title}
        </Link>
      ) : (
        <span className="truncate font-medium">{title}</span>
      )}
      <RequestFlags is4k={row.is4k} isAutoRequest={row.isAutoRequest} />
    </div>
  );
}

function RequestDataRow({
  row,
  leading,
  t,
}: {
  row: RequestRowCommon;
  leading: ReactNode;
  t: Translate;
}) {
  const seasons = formatSeasons(row.seasons, t);
  return (
    <TableRow>
      <TableCell className={cn(row.deletedAt !== null && 'line-through')}>{leading}</TableCell>
      <TableCell>
        <RequestStatusBadge status={row.status} deletedAt={row.deletedAt} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {format(new Date(row.requestedAt), 'MMM d, yyyy')}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {formatWait(row.waitMs, row.status, t)}
      </TableCell>
      <TableCell className="text-muted-foreground">{seasons ?? '—'}</TableCell>
      <TableCell>
        <WatchedBadge watchedState={row.watchedState} watchedStateSelf={row.watchedState} />
      </TableCell>
    </TableRow>
  );
}

export function RequestsTable(props: RequestsTableProps) {
  const { t: translate } = useTranslation('pages');
  const t = translate as Translate;
  const { isLoading, isError, onRetry, emptyTitle, subject, rows } = props;
  const caption =
    subject === 'media' ? t('requests.mediaPanel.title') : t('requests.userCard.title');
  const loadError =
    subject === 'media' ? t('requests.mediaPanel.loadError') : t('requests.userCard.loadError');

  if (isError) {
    return <InlineErrorState message={loadError} onRetry={onRetry} />;
  }

  if (!isLoading && rows.length === 0) {
    return <EmptyState title={emptyTitle} />;
  }

  return (
    <div className="overflow-x-auto">
      <Table aria-label={caption}>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>
              {subject === 'media' ? t('requests.columns.requester') : t('requests.columns.title')}
            </TableHead>
            <TableHead>{t('requests.columns.status')}</TableHead>
            <TableHead>{t('requests.columns.requested')}</TableHead>
            <TableHead>{t('requests.columns.wait')}</TableHead>
            <TableHead>{t('requests.columns.seasons')}</TableHead>
            <TableHead>{t('requests.columns.watched')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading
            ? Array.from({ length: 4 }).map((_, index) => (
                <TableRowSkeleton key={index} columns={COLUMN_COUNT} />
              ))
            : props.subject === 'media'
              ? props.rows.map((row) => (
                  <RequestDataRow
                    key={row.id}
                    row={row}
                    leading={<MediaLeadingCell row={row} />}
                    t={t}
                  />
                ))
              : props.rows.map((row) => (
                  <RequestDataRow
                    key={row.id}
                    row={row}
                    leading={<UserLeadingCell row={row} />}
                    t={t}
                  />
                ))}
        </TableBody>
      </Table>
    </div>
  );
}
