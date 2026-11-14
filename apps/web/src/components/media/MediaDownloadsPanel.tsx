import { useTranslation } from 'react-i18next';
import type { MediaDownloadRow } from '@tracearr/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DownloadDevice, DownloadUser, deliveredSize } from '@/components/downloads/DownloadsTable';
import { safeFormatDistanceToNow } from '@/lib/dateFormat';

interface MediaDownloadsPanelProps {
  rows: MediaDownloadRow[] | undefined;
}

export function MediaDownloadsPanel({ rows }: MediaDownloadsPanelProps) {
  const { t } = useTranslation(['pages', 'common']);

  if (!rows || rows.length === 0) return null;

  return (
    <section
      aria-labelledby="media-downloads-heading"
      className="bg-card rounded-xl border p-6 shadow-sm"
    >
      <h2 id="media-downloads-heading" className="mb-3 text-base font-semibold">
        {t('pages:downloads.panelTitle')}
      </h2>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t('common:labels.user')}</TableHead>
            <TableHead>{t('common:labels.when')}</TableHead>
            <TableHead>{t('common:labels.device')}</TableHead>
            <TableHead>{t('common:labels.size')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <DownloadUser row={row} />
              </TableCell>
              <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                <span title={row.firstSeenAt}>{safeFormatDistanceToNow(row.lastSeenAt)}</span>
              </TableCell>
              <TableCell>
                <DownloadDevice row={row} />
              </TableCell>
              <TableCell className="text-sm tabular-nums">{deliveredSize(row)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
