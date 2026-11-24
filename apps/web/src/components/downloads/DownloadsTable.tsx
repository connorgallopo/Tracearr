import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  classifyByDimensions,
  formatMediaTech,
  normalizeResolutionLabel,
  type MediaDownloadRow,
} from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ServerColumnCell } from '@/components/server';
import { useProfileLabel } from '@/components/sessions/useProfileLabel';
import { UserCell } from '@/components/users';
import { formatBytes } from '@/lib/formatters';
import { safeFormatDistanceToNow } from '@/lib/dateFormat';
import { formatLocationCompact } from '@/lib/utils';

const MUTED_DASH = <span className="text-muted-foreground">—</span>;

const DIMENSIONS = /^(\d+)x(\d+)$/;

function formatBitrate(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
}

/** A download is converted when it left the server smaller or in a different resolution tier than the source. */
export function isConvertedDownload(row: MediaDownloadRow): boolean {
  const delivered = DIMENSIONS.exec(row.deliveredResolution ?? '');
  const sourceTier = normalizeResolutionLabel(row.videoResolution);
  if (
    delivered &&
    sourceTier &&
    classifyByDimensions(Number(delivered[1]), Number(delivered[2])) !== sourceTier
  ) {
    return true;
  }
  return (
    row.deliveredBytes !== null &&
    row.fileSizeBytes !== null &&
    row.deliveredBytes < row.fileSizeBytes * 0.95
  );
}

/** A converted pull never sent its source file, so only its own byte count stands */
export function deliveredSize(row: MediaDownloadRow): string {
  const sourceBytes = row.source === 'jellyfin_transcode' ? null : row.fileSizeBytes;
  return formatBytes(row.deliveredBytes ?? sourceBytes, 1, { emptyValue: '—' });
}

export function DownloadUser({ row }: { row: MediaDownloadRow }) {
  const { t } = useTranslation('pages');
  if (row.username === null && row.identityName === null) {
    return <span className="text-muted-foreground">{t('downloads.unknownUser')}</span>;
  }
  return (
    <UserCell
      serverUserId={row.serverUserId}
      username={row.username}
      identityName={row.identityName}
      thumbUrl={row.thumbUrl}
      serverId={row.serverId}
      profileBadge={row.nonMainProfile && { serverId: row.serverId, profile: row.nonMainProfile }}
    />
  );
}

export function DownloadDevice({ row }: { row: MediaDownloadRow }) {
  const { t } = useTranslation('pages');
  const primary = row.playerName ?? row.platform;
  if (primary || row.product) {
    return (
      <div className="min-w-0">
        <div className="truncate text-sm">{primary ?? row.product}</div>
        {primary && row.product && (
          <div className="text-muted-foreground truncate text-xs">{row.product}</div>
        )}
      </div>
    );
  }
  if (row.app && row.device) {
    return (
      <span className="text-sm">
        {t('downloads.appOnDevice', { app: row.app, device: row.device })}
      </span>
    );
  }
  const fallback = row.app ?? row.device;
  return fallback ? <span className="text-sm">{fallback}</span> : MUTED_DASH;
}

export function deliveredFormat(row: MediaDownloadRow): string {
  return [
    row.deliveredResolution ?? '',
    [row.deliveredVideoCodec, row.deliveredAudioCodec]
      .filter((value): value is string => !!value)
      .map(formatMediaTech)
      .join('/'),
    row.deliveredContainer ? formatMediaTech(row.deliveredContainer) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function DownloadWhat({ row }: { row: MediaDownloadRow }) {
  const { t } = useTranslation('pages');
  const quality = [row.videoResolution, row.videoCodec]
    .filter((value): value is string => !!value)
    .map(formatMediaTech)
    .join(' · ');

  const format = deliveredFormat(row);

  const bitrate =
    row.deliveredBitrateKbps === null ? null : formatBitrate(row.deliveredBitrateKbps);
  const converted = isConvertedDownload(row) && (format !== '' || bitrate !== null);

  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-1.5">
        {row.mediaId ? (
          <Link to={`/media/${row.mediaId}`} className="truncate font-medium hover:underline">
            {row.title}
          </Link>
        ) : (
          <span className="truncate font-medium">{row.title}</span>
        )}
        {row.requestCount > 1 && (
          <span className="text-muted-foreground shrink-0 text-xs">
            {t('downloads.requests', { count: row.requestCount })}
          </span>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-2">
        {quality && (
          <Badge variant="outline" className="text-xs">
            {quality}
          </Badge>
        )}
        <span className="text-muted-foreground text-xs tabular-nums">{deliveredSize(row)}</span>
      </div>
      {converted && (
        <div className="text-muted-foreground text-xs">
          {bitrate === null
            ? t('downloads.deliveredAsFormat', { format })
            : format
              ? t('downloads.deliveredAs', { format, bitrate })
              : t('downloads.deliveredAtBitrate', { bitrate })}
        </div>
      )}
    </div>
  );
}

function DownloadProfile({ row }: { row: MediaDownloadRow }) {
  const profileLabel = useProfileLabel();
  return row.nonMainProfile ? (
    <span className="block truncate text-sm">{profileLabel(row.nonMainProfile)}</span>
  ) : null;
}

function DownloadWhere({ row }: { row: MediaDownloadRow }) {
  const { t } = useTranslation('common');
  if (row.isLocal) return <span className="text-sm">{t('labels.local')}</span>;
  const place = formatLocationCompact(row.geoCity, row.geoRegion, row.geoCountry);
  return place ? <span className="text-sm">{place}</span> : MUTED_DASH;
}

interface DownloadsTableProps {
  rows: MediaDownloadRow[];
  isLoading?: boolean;
  showUser: boolean;
  /** Names each row's non-main profile in a column of its own, for a table without the user column */
  showProfile?: boolean;
  showServer: boolean;
  empty: ReactNode;
}

export function DownloadsTable({
  rows,
  isLoading,
  showUser,
  showProfile = false,
  showServer,
  empty,
}: DownloadsTableProps) {
  const { t } = useTranslation('common');

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) return <>{empty}</>;

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t('labels.when')}</TableHead>
          {showUser && <TableHead>{t('labels.user')}</TableHead>}
          {showProfile && <TableHead>{t('labels.profile')}</TableHead>}
          <TableHead>{t('labels.content')}</TableHead>
          <TableHead>{t('labels.device')}</TableHead>
          <TableHead>{t('labels.location')}</TableHead>
          {showServer && <TableHead>{t('labels.server')}</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
              <span title={row.firstSeenAt}>{safeFormatDistanceToNow(row.lastSeenAt)}</span>
            </TableCell>
            {showUser && (
              <TableCell>
                <DownloadUser row={row} />
              </TableCell>
            )}
            {showProfile && (
              <TableCell>
                <DownloadProfile row={row} />
              </TableCell>
            )}
            <TableCell>
              <DownloadWhat row={row} />
            </TableCell>
            <TableCell>
              <DownloadDevice row={row} />
            </TableCell>
            <TableCell>
              <DownloadWhere row={row} />
            </TableCell>
            {showServer && (
              <TableCell>
                <ServerColumnCell server={{ id: row.serverId, name: row.serverName }} />
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
