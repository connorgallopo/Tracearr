import { useTranslation } from 'react-i18next';
import { CheckCircle, XCircle, SkipForward } from 'lucide-react';
import type { ActionResult } from '@tracearr/shared';

interface ActionResultsListProps {
  results: ActionResult[];
}

/**
 * Display a list of action execution results from a rule trigger.
 * Shows success/failure/skipped status for each action.
 */
export function ActionResultsList({ results }: ActionResultsListProps) {
  const { t } = useTranslation('pages');
  if (results.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-muted-foreground text-sm font-medium">
        {t('violations.detail.actionResults')}
      </h4>
      <ul className="space-y-1">
        {results.map((result, index) => (
          <li key={index} className="flex items-center gap-2 text-sm">
            {result.skipped ? (
              <SkipForward className="text-muted-foreground h-4 w-4" />
            ) : result.success ? (
              <CheckCircle className="text-success h-4 w-4" />
            ) : (
              <XCircle className="text-destructive h-4 w-4" />
            )}
            <span className="capitalize">{result.actionType.replace(/_/g, ' ')}</span>
            {result.skipped && result.skipReason && (
              <span className="text-muted-foreground">({result.skipReason})</span>
            )}
            {!result.success && !result.skipped && result.errorMessage && (
              <span className="text-destructive">({result.errorMessage})</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default ActionResultsList;
