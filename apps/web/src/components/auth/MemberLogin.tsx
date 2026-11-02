import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Loader2 } from 'lucide-react';
import type { SetupStatus } from '@tracearr/shared';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { AuthFormError } from '@/components/auth/AuthFormError';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { isNotPermitted, toastNotPermitted } from '@/lib/signInRefusal';
import {
  useMemberSignIn,
  useQuickConnectCheck,
  useQuickConnectCode,
} from '@/hooks/queries/useMemberLogin';

export type MemberLoginServer = SetupStatus['memberLoginServers'][number];

interface MemberLoginProps {
  servers: MemberLoginServer[];
  onSignedIn: () => Promise<void>;
}

function ServerLabel({ server }: { server: MemberLoginServer }) {
  return (
    <span className="flex items-center gap-2">
      <MediaServerIcon type={server.type} alt="" className="h-4 w-4" />
      {server.name}
    </span>
  );
}

export function MemberLogin({ servers, onSignedIn }: MemberLoginProps) {
  const { t } = useTranslation(['pages']);
  const [selectedId, setSelectedId] = useState(servers[0]?.id);
  const server = servers.find((s) => s.id === selectedId) ?? servers[0];

  if (!server) return null;

  return (
    <div className="space-y-4">
      {servers.length > 1 ? (
        <div className="space-y-2">
          <Label htmlFor="member-server">{t('pages:login.member.server')}</Label>
          <Select value={server.id} onValueChange={setSelectedId}>
            <SelectTrigger id="member-server" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {servers.map((s) => (
                <SelectItem key={s.id} value={s.id} textValue={s.name}>
                  <ServerLabel server={s} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <MediaServerIcon type={server.type} alt="" className="h-4 w-4" />
          {t('pages:login.member.signingInTo', { name: server.name })}
        </p>
      )}
      {/* Keyed so a different server starts with no code, error, or typed password */}
      <MemberCredentials key={server.id} server={server} onSignedIn={onSignedIn} />
    </div>
  );
}

function MemberCredentials({
  server,
  onSignedIn,
}: {
  server: MemberLoginServer;
  onSignedIn: () => Promise<void>;
}) {
  const { t } = useTranslation(['pages', 'common', 'settings']);
  const [passwordChosen, setPasswordChosen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const signedIn = useRef(false);

  const signIn = useMemberSignIn();
  const wantsCode = server.type === 'jellyfin' && server.quickConnect && !passwordChosen;
  const code = useQuickConnectCode(server.id, attempt, wantsCode);
  const check = useQuickConnectCheck(wantsCode ? code.data?.handle : undefined);

  const notPermitted = [signIn.error, code.error, check.error].some(isNotPermitted);
  useEffect(() => {
    if (notPermitted) toastNotPermitted(t('pages:login.member.notPermitted'));
  }, [notPermitted, t]);
  const shownError = (error: Error | null) =>
    error && !isNotPermitted(error) ? error.message : null;

  const quickConnectError = shownError(code.error) ?? shownError(check.error);
  // Quick Connect off, or failed: the password form is the only way left
  const showCode = wantsCode && code.data !== null && !quickConnectError && !notPermitted;
  const authorized = !!check.data?.authorized;

  useEffect(() => {
    if (!authorized || signedIn.current) return;
    signedIn.current = true;
    void onSignedIn();
  }, [authorized, onSignedIn]);

  const requestNewCode = () => {
    setPasswordChosen(false);
    setAttempt((n) => n + 1);
  };

  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    signIn.mutate(
      {
        type: server.type === 'emby' ? 'emby' : 'jellyfin',
        serverId: server.id,
        username: username.trim(),
        password,
      },
      { onSuccess: () => void onSignedIn() }
    );
  };

  if (showCode) {
    const expired = !!check.data?.expired;

    return (
      <div className="space-y-3">
        {code.isFetching || !code.data ? (
          <Skeleton className="h-16 w-full" />
        ) : expired ? (
          <output className="bg-muted/50 flex flex-col items-center gap-3 rounded-lg p-4 text-center">
            <p className="text-sm font-medium">{t('pages:login.member.codeExpired')}</p>
            {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- requesting a new code is the only action left */}
            <Button type="button" autoFocus onClick={requestNewCode}>
              {t('pages:login.member.newCode')}
            </Button>
          </output>
        ) : (
          <>
            <CopyButton
              value={code.data.code}
              label={t('pages:login.member.copyCode')}
              variant="ghost"
              className="h-auto w-full justify-center py-4 font-mono text-3xl tracking-[0.3em] sm:text-4xl"
            >
              {code.data.code}
            </CopyButton>
            <p className="text-muted-foreground text-center text-sm">
              {t('pages:login.member.quickConnectHint')}
            </p>
            <div className="bg-muted/50 flex items-center justify-center gap-2 rounded-lg p-4 text-sm">
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              {t('pages:login.member.waiting')}
            </div>
          </>
        )}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="mx-auto flex"
          onClick={() => setPasswordChosen(true)}
        >
          {t('pages:login.member.usePassword')}
        </Button>
      </div>
    );
  }

  const error = shownError(signIn.error) ?? quickConnectError;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-muted-foreground text-sm">
        {t('pages:login.member.passwordHint', { name: server.name })}
      </p>
      <div className="space-y-2">
        <Label htmlFor="member-username">{t('pages:login.username')}</Label>
        <Input
          id="member-username"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            signIn.reset();
          }}
          required
          disabled={signIn.isPending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="member-password">{t('settings:account.password')}</Label>
        <Input
          id="member-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            signIn.reset();
          }}
          required
          disabled={signIn.isPending}
          aria-describedby={error ? 'member-login-error' : undefined}
        />
      </div>
      <AuthFormError id="member-login-error" message={error} />
      <Button type="submit" className="w-full" disabled={signIn.isPending}>
        {signIn.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
        {t('common:actions.signIn')}
      </Button>
      {server.type === 'jellyfin' && server.quickConnect && passwordChosen && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="mx-auto flex"
          onClick={requestNewCode}
        >
          {t('pages:login.member.useQuickConnect')}
        </Button>
      )}
    </form>
  );
}
