import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTablePager } from '@/components/ui/data-table';
import { DownloadsTable } from '@/components/downloads/DownloadsTable';
import { useUserDownloads } from '@/hooks/queries';
import { usePagerLabels } from './usePagerLabels';

export const DOWNLOADS_PAGE_SIZE = 10;

interface DownloadsTabProps {
  userId: string;
  scope: 'identity' | undefined;
  showServer: boolean;
}

export function DownloadsTab({ userId, scope, showServer }: DownloadsTabProps) {
  const { t } = useTranslation('pages');
  const [page, setPage] = useState(1);
  const { data, isLoading } = useUserDownloads(userId, {
    page,
    pageSize: DOWNLOADS_PAGE_SIZE,
    scope,
  });
  const rows = data?.data ?? [];
  const pageCount = Math.ceil((data?.total ?? 0) / DOWNLOADS_PAGE_SIZE);
  const labels = usePagerLabels(page, pageCount);

  return (
    <div className="space-y-4">
      <DownloadsTable
        rows={rows}
        isLoading={isLoading}
        showUser={false}
        showProfile={rows.some((row) => row.nonMainProfile)}
        showServer={showServer}
        empty={<p className="text-muted-foreground text-sm">{t('downloads.empty')}</p>}
      />
      <DataTablePager
        page={page}
        pageCount={pageCount}
        canPrevious={page > 1}
        canNext={page < pageCount}
        onPrevious={() => setPage((current) => Math.max(1, current - 1))}
        onNext={() => setPage((current) => Math.min(pageCount, current + 1))}
        onPage={setPage}
        labels={labels}
      />
    </div>
  );
}
