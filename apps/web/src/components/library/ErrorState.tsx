import { AlertCircle, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry: () => void;
}

export function ErrorState({ title, message, onRetry }: ErrorStateProps) {
  const { t } = useTranslation('common');

  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <AlertCircle className="text-destructive mb-4 h-12 w-12" />
      <h3 className="mb-2 text-base font-medium">{title ?? t('errors.somethingWentWrong')}</h3>
      <p className="text-muted-foreground mb-4 max-w-md">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        <RefreshCw />
        {t('actions.tryAgain')}
      </Button>
    </div>
  );
}

interface InlineErrorStateProps {
  message: string;
  onRetry: () => void;
}

/**
 * Compact error state for a single card/section within a page that otherwise
 * loaded successfully - used where a full-page ErrorState would be too heavy.
 */
export function InlineErrorState({ message, onRetry }: InlineErrorStateProps) {
  const { t } = useTranslation('common');

  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-8 text-center">
      <AlertCircle className="text-destructive h-8 w-8" />
      <p className="text-muted-foreground text-sm">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="mr-2 h-3.5 w-3.5" />
        {t('actions.tryAgain')}
      </Button>
    </div>
  );
}
