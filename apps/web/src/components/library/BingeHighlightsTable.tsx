import { useTranslation } from 'react-i18next';
import { Zap } from 'lucide-react';
import type { BingeShow, Server } from '@tracearr/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ServerBadge } from '@/components/server';
import { EmptyState } from '@/components/ui/empty-state';

interface BingeHighlightsTableProps {
  data: BingeShow[] | undefined;
  isLoading?: boolean;
  selectedServers?: Server[];
  isMultiServer?: boolean;
}

/**
 * Table of shows people watched back to back: episode plays, consecutive plays, the people who
 * binged and the most episodes one person played in a day.
 * In multi-server mode adds a Server column showing all involved servers and applies a
 * per-row left-border accent using the primaryServerId color.
 */
export function BingeHighlightsTable({
  data,
  isLoading,
  selectedServers = [],
  isMultiServer = false,
}: BingeHighlightsTableProps) {
  const { t } = useTranslation(['pages', 'common']);

  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="text-muted-foreground">{t('common:states.loading')}</div>
      </div>
    );
  }

  if (!data?.length) {
    return (
      <EmptyState
        icon={Zap}
        title={t('library.watch.binge.empty.title')}
        description={t('library.watch.binge.empty.description')}
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('library.watch.binge.columns.show')}</TableHead>
          {isMultiServer && <TableHead>{t('library.watch.binge.columns.servers')}</TableHead>}
          <TableHead>{t('common:media.episode_plural')}</TableHead>
          <TableHead>{t('library.watch.binge.columns.consecutive')}</TableHead>
          <TableHead>{t('library.watch.binge.columns.people')}</TableHead>
          <TableHead>{t('library.watch.binge.columns.maxPerDay')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((show) => {
          const primaryColor = isMultiServer
            ? (selectedServers.find((s) => s.id === show.primaryServerId)?.color ?? null)
            : null;
          const accentStyle = primaryColor
            ? { boxShadow: `inset 3px 0 0 0 ${primaryColor}` }
            : undefined;

          return (
            <TableRow key={show.showMediaId} style={accentStyle}>
              <TableCell>
                <span className="font-medium">{show.showTitle}</span>
              </TableCell>
              {isMultiServer && (
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {show.serverIds.map((sid) => {
                      const server = selectedServers.find((s) => s.id === sid);
                      if (!server) return null;
                      return <ServerBadge key={sid} server={server} variant="compact" />;
                    })}
                  </div>
                </TableCell>
              )}
              <TableCell>{show.totalEpisodeWatches}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span>{show.consecutiveEpisodes}</span>
                  <span className="text-muted-foreground text-xs">
                    ({show.consecutivePct.toFixed(0)}%)
                  </span>
                </div>
              </TableCell>
              <TableCell>{show.people}</TableCell>
              <TableCell className="text-muted-foreground">{show.maxEpisodesInOneDay}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
