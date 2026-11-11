import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { AuthFormError } from '@/components/auth/AuthFormError';
import { authClient } from '@/lib/authClient';

/** Creates the owner's Tracearr account with a username and password. */
export function OwnerSignUpForm({
  claimCode,
  onCreated,
  formId,
  onPendingChange,
}: {
  claimCode: string | undefined;
  onCreated: () => Promise<void>;
  /** Names the form so a button elsewhere can submit it; the in-form button goes away. */
  formId?: string;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { t } = useTranslation(['pages', 'settings']);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);

    try {
      // signUp.email's typed client only accepts declared additionalFields;
      // username and claimCode aren't declared there, so post through $fetch
      // (the server's sign-up/email schema accepts arbitrary extra fields).
      const { error: signUpError } = await authClient.$fetch('/sign-up/email', {
        method: 'POST',
        body: {
          name: name.trim(),
          username: username.trim().toLowerCase(),
          email: email.trim(),
          password,
          ...(claimCode !== undefined && { claimCode }),
        },
      });

      if (signUpError) {
        setError(signUpError.message ?? t('pages:login.createAccountFailed'));
        return;
      }

      await onCreated();
    } finally {
      setPending(false);
    }
  };

  return (
    <form id={formId} onSubmit={handleSubmit}>
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="name">{t('settings:account.displayName')}</FieldLabel>
          <Input
            id="name"
            type="text"
            autoComplete="name"
            placeholder={t('pages:login.displayNamePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={pending}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="username">{t('pages:login.username')}</FieldLabel>
          <Input
            id="username"
            type="text"
            autoComplete="username"
            placeholder={t('pages:login.usernamePlaceholder')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            maxLength={30}
            disabled={pending}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="email">{t('settings:account.email')}</FieldLabel>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder={t('pages:login.emailPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={pending}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">{t('settings:account.password')}</FieldLabel>
          <PasswordInput
            id="password"
            autoComplete="new-password"
            placeholder={t('pages:login.passwordPlaceholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            disabled={pending}
          />
        </Field>
        <AuthFormError message={error} />
        {!formId && (
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <User />}
            {t('settings:account.createAccount')}
          </Button>
        )}
      </FieldGroup>
    </form>
  );
}
