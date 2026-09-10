import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { Download, MoreHorizontal, Trash2 } from 'lucide-react';
import type { BackupListItem } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatBytes } from '@/lib/formatters';
import { getFullDateTimeFormatString } from '@/lib/timeFormat';
import { api } from '@/lib/api';
import { dateLabel } from '@/components/settings/shared/dateLabel';

interface BackupRow {
  filename: string;
  date: string;
  fullDate: string;
  typeLabel: string;
  size: string;
  version: string;
  item: BackupListItem;
}

export function BackupHistory({
  backups,
  isLoading,
  onRestore,
  onDelete,
}: {
  backups: BackupListItem[];
  isLoading: boolean;
  onRestore: (backup: BackupListItem) => void;
  onDelete: (filename: string) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);

  const typeLabel = (type: string) =>
    type === 'manual'
      ? t('backup.typeManual')
      : type === 'scheduled'
        ? t('backup.typeScheduled')
        : type === 'uploaded'
          ? t('backup.typeUploaded')
          : type;

  const rows: BackupRow[] = backups.map((item) => ({
    filename: item.filename,
    date: dateLabel(item.createdAt),
    fullDate: format(new Date(item.createdAt), getFullDateTimeFormatString()),
    typeLabel: typeLabel(item.type),
    size: formatBytes(item.size, 2),
    version: item.metadata.app.version,
    item,
  }));

  const rowMenu = (row: BackupRow) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t('backup.rowActions')}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onRestore(row.item)}>
          {t('backup.restoreAction')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void api.backup.download(row.filename)}>
          <Download />
          {t('backup.download')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(row.filename)}>
          <Trash2 />
          {t('common:actions.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground py-4 text-center text-sm">{t('backup.noBackups')}</p>
    );
  }

  return (
    <div className="@container/backup-history">
      <div data-testid="backup-table" className="hidden @2xl/backup-history:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('backup.date')}</TableHead>
              <TableHead>{t('backup.type')}</TableHead>
              <TableHead>{t('backup.size')}</TableHead>
              <TableHead>{t('backup.version')}</TableHead>
              <TableHead className="text-right">{t('backup.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.filename} title={row.filename}>
                <TableCell title={row.fullDate}>{row.date}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{row.typeLabel}</Badge>
                </TableCell>
                <TableCell className="tabular-nums">{row.size}</TableCell>
                <TableCell className="tabular-nums">{row.version}</TableCell>
                <TableCell className="text-right">{rowMenu(row)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ItemGroup data-testid="backup-list" className="gap-2 @2xl/backup-history:hidden">
        {rows.map((row) => (
          <Item key={row.filename} role="listitem" variant="outline" size="sm" title={row.filename}>
            <ItemContent>
              <ItemTitle title={row.fullDate}>{row.date}</ItemTitle>
              <ItemDescription className="tabular-nums">
                {row.typeLabel} &middot; {row.size} &middot; {row.version}
              </ItemDescription>
            </ItemContent>
            <ItemActions>{rowMenu(row)}</ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </div>
  );
}
