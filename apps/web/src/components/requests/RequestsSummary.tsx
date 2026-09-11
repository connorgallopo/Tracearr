import { useTranslation } from 'react-i18next';
import type { UserRequestsSummary } from '@tracearr/shared';
import { formatDuration, formatPercent } from '@/lib/formatters';

interface RequestsSummaryProps {
  summary: UserRequestsSummary;
}

export function RequestsSummary({ summary }: RequestsSummaryProps) {
  const { t } = useTranslation('pages');

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <div className="rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">
            {t('requests.userCard.summary.requests')}
          </span>
        </div>
        <p className="mt-1 text-2xl font-bold">{summary.total}</p>
        {summary.medianWaitMs !== null && (
          <p className="text-muted-foreground mt-1 text-xs">
            {t('requests.userCard.summary.medianWait', {
              duration: formatDuration(summary.medianWaitMs, { style: 'compactShort' }),
            })}
          </p>
        )}
      </div>
      <div className="rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">
            {t('requests.userCard.summary.approvalRate')}
          </span>
        </div>
        <p className="mt-1 text-2xl font-bold">{formatPercent(summary.approvalRate, 0, true)}</p>
      </div>
      <div className="rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">
            {t('requests.userCard.summary.neverWatched')}
          </span>
        </div>
        <p className="mt-1 text-2xl font-bold">{summary.neverWatched}</p>
      </div>
    </div>
  );
}
