import { useEffect } from 'react';
import { Link, useRouteError } from 'react-router';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { recordClientError } from '@/lib/clientErrors';

export function RouteError() {
  const error = useRouteError();
  const { t } = useTranslation(['common']);

  useEffect(() => {
    recordClientError('route', error);
  }, [error]);

  const message = error instanceof Error ? error.message : String(error);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <TriangleAlert className="text-muted-foreground h-8 w-8" />
      <h1 className="text-xl font-semibold">{t('common:errors.somethingWentWrong')}</h1>
      <p className="text-muted-foreground max-w-md font-mono text-xs break-words">{message}</p>
      <div className="flex gap-2">
        <Button onClick={() => window.location.reload()}>{t('common:actions.reload')}</Button>
        <Button variant="outline" asChild>
          <Link to="/">{t('common:actions.goHome')}</Link>
        </Button>
      </div>
    </div>
  );
}
