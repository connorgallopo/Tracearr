import { useTranslation } from 'react-i18next';
import { AlertCircle, XCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { SignInFailure } from '@/lib/signInRefusal';

export function AuthFormError({ id, message }: { id?: string; message: string | null }) {
  if (!message) return null;

  return (
    <p id={id} className="text-destructive flex items-center gap-1.5 text-sm" role="alert">
      <AlertCircle className="h-4 w-4 shrink-0" />
      {message}
    </p>
  );
}

/** A sign-in the server no longer holds, with the way to start it over. */
export function SignInAgainAlert({
  title,
  onSignInAgain,
}: {
  title: string;
  onSignInAgain: () => void;
}) {
  const { t } = useTranslation('pages');

  return (
    <Alert variant="destructive">
      <XCircle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <Button variant="outline" size="sm" className="mt-2" onClick={onSignInAgain}>
          {t('setup.signInAgain')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** A sign-in that expired or failed before reaching a server list, shown where it was started. */
export function SignInFailedAlert({
  error,
  onSignInAgain,
}: {
  error: SignInFailure | null;
  onSignInAgain: () => void;
}) {
  const { t } = useTranslation(['pages', 'common']);

  switch (error?.kind) {
    case 'expired':
      return (
        <SignInAgainAlert title={t('pages:setup.codeExpired')} onSignInAgain={onSignInAgain} />
      );
    case 'failed':
      return (
        <SignInAgainAlert
          title={error.message ?? t('common:errors.generic')}
          onSignInAgain={onSignInAgain}
        />
      );
    default:
      return null;
  }
}
