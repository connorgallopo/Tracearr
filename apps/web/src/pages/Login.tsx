import { type ReactNode, useState, useEffect, useEffectEvent } from 'react';
import { useLocation, useNavigate, useSearchParams, type Location } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, KeyRound, LogIn, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { authClient } from '@/lib/authClient';
import { api, BASE_URL } from '@/lib/api';
import { dropUserData } from '@/lib/queryCache';
import { useSetupStatus } from '@/hooks/queries/useSetup';
import { type SignInFailure, toastNotPermitted } from '@/lib/signInRefusal';
import { SERVER_PROFILES, SIGN_IN_ERROR_CODES, type SetupStatus } from '@tracearr/shared';
import { LogoIcon } from '@/components/brand/Logo';
import { PlexServerSelector } from '@/components/auth/PlexServerSelector';
import { AuthFormError, SignInAgainAlert } from '@/components/auth/AuthFormError';
import { MemberLogin } from '@/components/auth/MemberLogin';
import { PlexSignInButton, PlexWaiting } from '@/components/auth/PlexSignIn';
import { TofaSignInButton, TofaWaiting } from '@/components/auth/TofaSignIn';
import { usePlexSignIn } from '@/components/auth/usePlexSignIn';
import { useTofaSignIn } from '@/components/auth/useTofaSignIn';
import { FirstRun } from '@/components/setup/FirstRun';

const DEFAULT_AUTH_METHODS: SetupStatus['authMethods'] = {
  local: true,
  plex: true,
  oidc: false,
  oidcProviderName: null,
  tofa: false,
  member: false,
  ssoOnly: false,
};

export function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const from = (useLocation().state as { from?: Location } | null)?.from;
  const redirectTo =
    searchParams.get('redirect') || (from ? `${from.pathname}${from.search}${from.hash}` : '/');
  const queryClient = useQueryClient();
  const { t } = useTranslation(['pages', 'common', 'settings', 'notifications']);
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  // Sign In mode unless the server says otherwise, since most visitors are returning users. If
  // the server never answers, the defaults stand and it will say so when it comes back.
  const { data: setup, isLoading: setupLoading } = useSetupStatus(searchParams.has('all'));
  const needsSetup = setup?.needsSetup ?? false;
  const requiresClaimCode = setup?.requiresClaimCode ?? false;
  const authMethods = setup?.authMethods ?? DEFAULT_AUTH_METHODS;
  const memberLoginServers = setup?.memberLoginServers ?? [];
  const [claimCodeValidated, setClaimCodeValidated] = useState(false);

  // Set by a first-run sign-up, which continues at /setup rather than where /login was opened from
  const [destination, setDestination] = useState<string | null>(null);

  // Local sign-in form state; the identifier is an email or a username
  const [localPending, setLocalPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');

  // OIDC state
  const [oidcPending, setOidcPending] = useState(false);
  const [oidcError, setOidcError] = useState<string | null>(null);

  // Claim code gate state
  const [claimCode, setClaimCode] = useState('');
  const [claimCodeLoading, setClaimCodeLoading] = useState(false);

  // Surface OIDC callback errors (redirected here as /login?error=<code>)
  useEffect(() => {
    const code = searchParams.get('error');
    if (code === SIGN_IN_ERROR_CODES.notPermitted) {
      toastNotPermitted(t('pages:login.member.notPermitted'));
    } else if (code) {
      setOidcError(
        code === SIGN_IN_ERROR_CODES.refused
          ? t('pages:login.member.refused')
          : t('pages:login.oidcError')
      );
    }
  }, [searchParams, t]);

  // Redirect if already authenticated
  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      void navigate(destination ?? redirectTo, { replace: true });
    }
  }, [isAuthenticated, authLoading, navigate, destination, redirectTo]);

  // Handle claim code validation (immediate feedback, server validates again during signup)
  const handleClaimCodeValidation = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setClaimCodeLoading(true);

    try {
      await api.auth.validateClaimCode({ claimCode: claimCode.trim() });
      toast.success(t('notifications:toast.success.claimCodeValidated.title'), {
        description: t('notifications:toast.success.claimCodeValidated.message'),
      });
      setClaimCodeValidated(true);
    } catch (error) {
      toast.error(t('notifications:toast.error.invalidClaimCode.title'), {
        description:
          error instanceof Error
            ? error.message
            : t('notifications:toast.error.invalidClaimCode.message'),
      });
    } finally {
      setClaimCodeLoading(false);
    }
  };

  // A new sign-in must not be served what the previous person left in the cache
  const refreshSession = async () => {
    dropUserData(queryClient);
    await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
  };

  const finishSignIn = async (
    description = t('notifications:toast.success.loggedIn.message'),
    to = redirectTo
  ) => {
    setDestination(to);
    await refreshSession();
    toast.success(t('notifications:toast.success.loggedIn.title'), { description });
    void navigate(to);
  };

  const claimCodeToSend = requiresClaimCode ? claimCode.trim() : undefined;
  const plex = usePlexSignIn({
    claimCode: claimCodeToSend,
    onSignedIn: (connectedServer) =>
      connectedServer
        ? finishSignIn(t('pages:login.connectedTo', { name: connectedServer }))
        : finishSignIn(),
  });

  const tofa = useTofaSignIn({ purpose: 'sign-in', onSignedIn: () => finishSignIn() });

  // Effect events, so a language change while an error shows does not toast it again
  const toastPlexError = useEffectEvent((error: SignInFailure) => {
    if (error.kind === 'expired') {
      toast.error(t('pages:login.plexExpired'));
    } else {
      toast.error(t('common:errors.connectionFailed'), {
        description: error.message ?? t('pages:login.serverConnectFailed'),
      });
    }
  });
  const toastTofaError = useEffectEvent((message: string | undefined) => {
    toast.error(t('notifications:toast.error.authFailed'), {
      ...(message !== undefined && { description: message }),
    });
  });

  useEffect(() => {
    if (plex.error) toastPlexError(plex.error);
  }, [plex.error]);

  useEffect(() => {
    if (tofa.error?.kind === 'failed') toastTofaError(tofa.error.message);
  }, [tofa.error]);

  // Handle local sign-in - identifier can be an email or a username
  const handleSignIn = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);
    setLocalPending(true);

    try {
      const trimmedIdentifier = identifier.trim();
      const call = trimmedIdentifier.includes('@')
        ? authClient.signIn.email({ email: trimmedIdentifier, password })
        : authClient.signIn.username({ username: trimmedIdentifier.toLowerCase(), password });
      const { error } = await call;

      if (error?.code === SIGN_IN_ERROR_CODES.notPermitted) {
        toastNotPermitted(t('pages:login.member.notPermitted'));
        return;
      }
      if (error) {
        setFormError(error.message ?? t('pages:login.invalidCredentials'));
        return;
      }

      await finishSignIn();
    } finally {
      setLocalPending(false);
    }
  };

  // Handle OIDC sign-in - redirects the browser to the provider on success
  const handleOidcLogin = async () => {
    setOidcPending(true);
    setOidcError(null);

    const { error } = await authClient.signIn.social({
      provider: 'oidc',
      callbackURL: BASE_URL,
      errorCallbackURL: `${BASE_URL}login`,
      ...(requiresClaimCode && { additionalData: { claimCode: claimCode.trim() } }),
    });

    if (error) {
      setOidcError(error.message ?? t('pages:login.oidcError'));
      setOidcPending(false);
    }
  };

  // Show loading while checking auth/setup status
  if (authLoading || setupLoading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <LogoIcon className="h-16 w-16 animate-pulse" />
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  // Claim code gate - shown before any setup options
  if (needsSetup && requiresClaimCode && !claimCodeValidated) {
    return (
      <div className="bg-background flex min-h-screen flex-col items-center justify-center p-4">
        <div className="mb-8 flex flex-col items-center text-center">
          <LogoIcon className="mb-4 h-20 w-20" />
          <h1 className="text-4xl font-bold tracking-tight">{t('pages:login.title')}</h1>
          <p className="text-muted-foreground mt-2">{t('pages:login.claimCodeRequired')}</p>
        </div>

        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              {t('pages:login.enterClaimCode')}
            </CardTitle>
            <CardDescription>{t('pages:login.claimCodeDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleClaimCodeValidation} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="gate-claimCode">
                  {t('pages:login.claimCodeLabel')}
                  <span className="text-destructive ml-1">*</span>
                </Label>
                <Input
                  id="gate-claimCode"
                  type="text"
                  placeholder=""
                  value={claimCode}
                  onChange={(e) => setClaimCode(e.target.value.toUpperCase())}
                  required
                  disabled={claimCodeLoading}
                  className="font-mono text-lg tracking-wider"
                  // oxlint-disable-next-line jsx-a11y/no-autofocus -- the claim code is the only field on this step
                  autoFocus
                />
                <p className="text-muted-foreground text-xs">{t('pages:login.claimCodeHint')}</p>
              </div>
              <Button type="submit" className="w-full" disabled={claimCodeLoading}>
                {claimCodeLoading ? <Loader2 className="animate-spin" /> : <KeyRound />}
                {t('pages:login.validateClaimCode')}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-muted-foreground mt-6 text-center text-xs">
          {t('pages:login.claimCodeSecurityNote')}
        </p>
      </div>
    );
  }

  if (needsSetup) {
    return <FirstRun claimCode={claimCodeToSend} onSignedIn={finishSignIn} />;
  }

  // Plex signup picks a server here only when the setup status never arrived to say first run
  if (plex.step === 'server-select' && plex.servers.length > 0) {
    return (
      <div className="bg-background flex min-h-screen flex-col items-center justify-center p-4">
        <div className="mb-8 flex flex-col items-center text-center">
          <LogoIcon className="mb-4 h-20 w-20" />
          <h1 className="text-4xl font-bold tracking-tight">{t('pages:login.title')}</h1>
          <p className="text-muted-foreground mt-2">{t('pages:login.selectPlexServer')}</p>
        </div>

        <Card className="w-fit max-w-[calc(100vw-2rem)] min-w-[28rem]">
          <CardHeader>
            <CardTitle>{t('settings:plex.selectServer')}</CardTitle>
            <CardDescription>{t('settings:plex.chooseServer')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <PlexServerSelector
              servers={plex.servers}
              onSelect={(uri, name, clientIdentifier) => {
                void plex.selectServer(uri, name, clientIdentifier);
              }}
              connecting={plex.connectingTo !== null}
              connectingToServer={plex.connectingTo}
              onCancel={plex.cancel}
              onTestCustomUrl={plex.testCustomUrl}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  const memberServers = memberLoginServers.filter(
    (server) => SERVER_PROFILES[server.type].memberSignIn === 'serverPassword'
  );
  // authMethods.plex is the owner's own Plex sign-in; a member's Plex server arrives in the
  // member list and signs in through the same button.
  const showPlex =
    authMethods.plex ||
    (authMethods.member &&
      memberLoginServers.some((server) => SERVER_PROFILES[server.type].memberSignIn === 'plexTv'));
  // Likewise authMethods.tofa is the owner's own tofa sign-in; members come through their server.
  const showTofa =
    authMethods.tofa ||
    (authMethods.member &&
      memberLoginServers.some(
        (server) => SERVER_PROFILES[server.type].memberSignIn === 'tofaCloud'
      ));
  const showMember = authMethods.member && memberServers.length > 0;
  const hasPrimaryMethods = showPlex || showTofa || authMethods.oidc;
  const hasFormMethods = authMethods.local || showMember;

  const localForm = (
    <form onSubmit={handleSignIn} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="identifier">{t('pages:login.usernameOrEmail')}</Label>
        <Input
          id="identifier"
          type="text"
          autoComplete="username"
          placeholder={t('pages:login.identifierPlaceholder')}
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          required
          disabled={localPending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">{t('settings:account.password')}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          placeholder={t('pages:login.yourPasswordPlaceholder')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          disabled={localPending}
        />
      </div>
      <AuthFormError message={formError} />
      <Button type="submit" className="w-full" disabled={localPending}>
        {localPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
        {t('common:actions.signIn')}
      </Button>
    </form>
  );

  const memberLogin = <MemberLogin servers={memberServers} onSignedIn={finishSignIn} />;

  // Two forms with a password field each would stack into a long page on a phone
  let formArea: ReactNode = authMethods.ssoOnly ? null : (
    <p className="text-muted-foreground text-center text-sm">
      {t('pages:login.localDisabledHint')}
    </p>
  );
  if (authMethods.local && showMember) {
    formArea = (
      <Tabs defaultValue="local">
        <TabsList className="w-full">
          <TabsTrigger value="local" className="flex-1">
            {t('pages:login.member.tabLocal')}
          </TabsTrigger>
          <TabsTrigger value="member" className="flex-1">
            {t('pages:login.member.tabMember')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="local">{localForm}</TabsContent>
        <TabsContent value="member">{memberLogin}</TabsContent>
      </Tabs>
    );
  } else if (authMethods.local) {
    formArea = localForm;
  } else if (showMember) {
    formArea = memberLogin;
  }

  return (
    <div className="bg-background flex min-h-screen flex-col items-center justify-center p-4">
      <div className="mb-8 flex flex-col items-center text-center">
        <LogoIcon className="mb-4 h-20 w-20" />
        <h1 className="text-4xl font-bold tracking-tight">{t('pages:login.title')}</h1>
        <p className="text-muted-foreground mt-2">{t('pages:login.signInHeading')}</p>
      </div>

      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('common:actions.signIn')}</CardTitle>
          <CardDescription>{t('pages:login.signInDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {oidcError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{oidcError}</AlertDescription>
            </Alert>
          )}

          {tofa.error?.kind === 'expired' && (
            <SignInAgainAlert
              title={t('pages:setup.codeExpired')}
              onSignInAgain={() => void tofa.start()}
            />
          )}

          {plex.step === 'waiting' && <PlexWaiting authUrl={plex.authUrl} onCancel={plex.cancel} />}
          {tofa.step === 'waiting' && (
            <TofaWaiting
              verificationUri={tofa.verificationUri}
              userCode={tofa.userCode}
              expiresAt={tofa.expiresAt}
              onCancel={tofa.cancel}
            />
          )}
          {plex.step !== 'waiting' && tofa.step !== 'waiting' && (
            <>
              {showPlex && (
                <PlexSignInButton
                  label={t('settings:plex.signInWithPlex')}
                  onClick={() => void plex.start()}
                />
              )}

              {showTofa && (
                <TofaSignInButton
                  label={t('pages:tofa.signIn')}
                  onClick={() => void tofa.start()}
                />
              )}

              {authMethods.oidc && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={oidcPending}
                  onClick={handleOidcLogin}
                >
                  {oidcPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <LogIn className="mr-2 h-4 w-4" />
                  )}
                  {t('pages:login.continueWith', { provider: authMethods.oidcProviderName })}
                </Button>
              )}

              {hasPrimaryMethods && hasFormMethods && (
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card text-muted-foreground px-2">{t('common:or')}</span>
                  </div>
                </div>
              )}

              {formArea}
            </>
          )}
        </CardContent>
      </Card>

      <p className="text-muted-foreground mt-6 text-center text-xs">{t('pages:login.tagline')}</p>
    </div>
  );
}
