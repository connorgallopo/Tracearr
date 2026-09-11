import { useTranslation } from 'react-i18next';
import type { MediaRequestEntry } from '@tracearr/shared';
import { RequestsTable } from '@/components/requests/RequestsTable';

interface MediaRequestsPanelProps {
  rows: MediaRequestEntry[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

export function MediaRequestsPanel({ rows, isLoading, isError, onRetry }: MediaRequestsPanelProps) {
  const { t } = useTranslation('pages');

  if (!isLoading && !isError && (rows === undefined || rows.length === 0)) return null;

  return (
    <section
      aria-labelledby="media-requests-heading"
      className="bg-card rounded-[calc(var(--radius)+2px)] border p-[16px_18px]"
    >
      <h2 id="media-requests-heading" className="mb-3 text-[15px] font-semibold">
        {t('requests.mediaPanel.title')}
      </h2>

      <RequestsTable
        subject="media"
        rows={rows ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={onRetry}
        emptyTitle={t('requests.mediaPanel.empty')}
      />
    </section>
  );
}
