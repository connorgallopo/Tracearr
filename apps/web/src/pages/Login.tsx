import { type ReactNode, useState, useEffect } from 'react';
import { useLocation, useNavigate, useSearchParams, type Location } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, ExternalLink, User, KeyRound, LogIn, AlertTriangle } from 'lucide-react';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
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
import { isNotPermitted, toastNotPermitted } from '@/lib/signInRefusal';
import {
  SERVER_PROFILES,
  SIGN_IN_ERROR_CODES,
  type PlexDiscoveredServer,
  type SetupStatus,
} from '@tracearr/shared';
import { LogoIcon } from '@/components/brand/Logo';
import { PlexServerSelector } from '@/components/auth/PlexServerSelector';
import { AuthFormError } from '@/components/auth/AuthFormError';
import { MemberLogin } from '@/components/auth/MemberLogin';

// Plex brand color
const PLEX_COLOR = 'bg-[#E5A00D] hover:bg-[#C88A0B]';

const DEFAULT_AUTH_METHODS: SetupStatus['authMethods'] = {
  local: true,
  plex: true,
  oidc: false,
  oidcProviderName: null,
  member: false,
  ssoOnly: false,
};

type AuthStep = 'initial' | 'plex-waiting' | 'server-select';

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

  // Auth flow state
  const [authStep, setAuthStep] = useState<AuthStep>('initial');
  const [plexAuthUrl, setPlexAuthUrl] = useState<string | null>(null);
  const [plexServers, setPlexServers] = useState<PlexDiscoveredServer[]>([]);
  const [plexTempToken, setPlexTempToken] = useState<string | null>(null);
  const [connectingToServer, setConnectingToServer] = useState<string | null>(null);
  const [plexPopup, setPlexPopup] = useState<ReturnType<typeof window.open>>(null);

  // Local auth form state (sign-in uses a single identifier field; sign-up
  // collects a display name and a separate login username)
  const [localPending, setLocalPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [signupUsername, setSignupUsername] = useState('');
  const [email, setEmail] = useState('');

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
      void navigate(redirectTo, { replace: true });
    }
  }, [isAuthenticated, authLoading, navigate, redirectTo]);

  // Close Plex popup helper
  const closePlexPopup = () => {
    if (plexPopup && !plexPopup.closed) {
      plexPopup.close();
    }
    setPlexPopup(null);
  };

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

  const finishSignIn = async () => {
    await refreshSession();
    toast.success(t('notifications:toast.success.loggedIn.title'), {
      description: t('notifications:toast.success.loggedIn.message'),
    });
    void navigate(redirectTo);
  };

  // Poll for Plex PIN claim
  const pollPlexPin = async (handle: string) => {
    try {
      const result = await api.auth.checkPlexPin({
        handle,
        ...(requiresClaimCode && { claimCode: claimCode.trim() }),
      });

      if (result.expired) {
        resetPlexAuth();
        toast.error(t('pages:login.plexExpired'));
        return;
      }
      if (!result.authorized) {
        // Still waiting for PIN claim, continue polling
        setTimeout(() => void pollPlexPin(handle), 2000);
        return;
      }

      // PIN claimed - close the popup
      closePlexPopup();

      // Check what we got back
      if (result.needsServerSelection && result.servers && result.tempToken) {
        // New user - needs to select a server
        setPlexServers(result.servers);
        setPlexTempToken(result.tempToken);
        setAuthStep('server-select');
      } else if (result.user) {
        // User authenticated (returning or no servers) - session cookie is already set
        await finishSignIn();
      }
    } catch (error) {
      resetPlexAuth();
      if (isNotPermitted(error)) {
        toastNotPermitted(t('pages:login.member.notPermitted'));
        return;
      }
      toast.error(t('notifications:toast.error.authFailed'), {
        description: error instanceof Error ? error.message : t('pages:login.plexAuthFailed'),
      });
    }
  };

  // Start Plex OAuth flow
  const handlePlexLogin = async () => {
    setAuthStep('plex-waiting');

    // Open popup to blank page first (same origin) - helps with cross-origin close
    const popup = window.open('about:blank', 'plex_auth', 'width=600,height=700,popup=yes');
    setPlexPopup(popup);

    try {
      // Pass callback URL so Plex redirects back to our domain after auth
      const callbackUrl = `${window.location.origin}${BASE_URL}auth/plex-callback`;
      const result = await api.auth.initiatePlex(callbackUrl);
      setPlexAuthUrl(result.authUrl);

      // Navigate popup to Plex auth
      if (popup && !popup.closed) {
        popup.location.assign(result.authUrl);
      }

      // Start polling
      void pollPlexPin(result.handle);
    } catch (error) {
      closePlexPopup();
      setAuthStep('initial');
      toast.error(t('common:errors.generic'), {
        description: error instanceof Error ? error.message : t('pages:login.plexStartFailed'),
      });
    }
  };

  // Connect to selected Plex server
  const handlePlexServerSelect = async (
    serverUri: string,
    serverName: string,
    clientIdentifier: string
  ) => {
    if (!plexTempToken) return;

    setConnectingToServer(serverName);

    try {
      const result = await api.auth.connectPlexServer({
        tempToken: plexTempToken,
        serverUri,
        serverName,
        clientIdentifier,
        ...(requiresClaimCode && { claimCode: claimCode.trim() }),
      });

      if (result.authorized) {
        await refreshSession();
        toast.success(t('notifications:toast.success.loggedIn.title'), {
          description: t('pages:login.connectedTo', { name: serverName }),
        });
        void navigate(redirectTo);
      }
    } catch (error) {
      toast.error(t('common:errors.connectionFailed'), {
        description: error instanceof Error ? error.message : t('pages:login.serverConnectFailed'),
      });
    } finally {
      setConnectingToServer(null);
    }
  };

  // Reset Plex auth state
  const resetPlexAuth = () => {
    // Close popup if still open
    if (plexPopup && !plexPopup.closed) {
      plexPopup.close();
    }
    setPlexPopup(null);
    setAuthStep('initial');
    setPlexAuthUrl(null);
    setPlexServers([]);
    setPlexTempToken(null);
    setConnectingToServer(null);
  };

  // Handle local sign-up (first-run owner account creation)
  const handleSignUp = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);
    setLocalPending(true);

    try {
      // signUp.email's typed client only accepts declared additionalFields;
      // username and claimCode aren't declared there, so post through $fetch
      // (the server's sign-up/email schema accepts arbitrary extra fields).
      const { error } = await authClient.$fetch('/sign-up/email', {
        method: 'POST',
        body: {
          name: name.trim(),
          username: signupUsername.trim().toLowerCase(),
          email: email.trim(),
          password,
          ...(requiresClaimCode && { claimCode: claimCode.trim() }),
        },
      });

      if (error) {
        setFormError(error.message ?? t('pages:login.createAccountFailed'));
        return;
      }

      await refreshSession();
      toast.success(t('notifications:toast.success.loggedIn.title'), {
        description: t('pages:login.accountCreated'),
      });
      void navigate(redirectTo);
    } finally {
      setLocalPending(false);
    }
  };

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

  // Server selection step (only during Plex signup)
  if (authStep === 'server-select' && plexServers.length > 0) {
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
              servers={plexServers}
              onSelect={handlePlexServerSelect}
              connecting={connectingToServer !== null}
              connectingToServer={connectingToServer}
              onCancel={resetPlexAuth}
              onTestCustomUrl={
                plexTempToken
                  ? async (uri) => {
                      const result = await api.auth.testPlexConnection({
                        uri,
                        tempToken: plexTempToken,
                        ...(requiresClaimCode && claimCode.trim()
                          ? { claimCode: claimCode.trim() }
                          : {}),
                      });
                      return result.connection;
                    }
                  : undefined
              }
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  const memberServers = memberLoginServers.filter(
    (server) => SERVER_PROFILES[server.type].signsInWithServerPassword
  );
  // authMethods.plex is the owner's own Plex sign-in; a member's Plex server arrives in the
  // member list and signs in through the same button.
  const showPlex =
    authMethods.plex ||
    (authMethods.member &&
      memberLoginServers.some((server) => !SERVER_PROFILES[server.type].signsInWithServerPassword));
  const showMember = authMethods.member && !needsSetup && memberServers.length > 0;
  const hasPrimaryMethods = showPlex || authMethods.oidc;
  const hasFormMethods = authMethods.local || showMember;

  const localForm = needsSetup ? (
    <form onSubmit={handleSignUp} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">{t('settings:account.displayName')}</Label>
        <Input
          id="name"
          type="text"
          autoComplete="name"
          placeholder={t('pages:login.displayNamePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          disabled={localPending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="username">{t('pages:login.username')}</Label>
        <Input
          id="username"
          type="text"
          autoComplete="username"
          placeholder={t('pages:login.usernamePlaceholder')}
          value={signupUsername}
          onChange={(e) => setSignupUsername(e.target.value)}
          required
          minLength={3}
          maxLength={30}
          disabled={localPending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">{t('settings:account.email')}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder={t('pages:login.emailPlaceholder')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={localPending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">{t('settings:account.password')}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          placeholder={t('pages:login.passwordPlaceholder')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          disabled={localPending}
        />
      </div>
      <AuthFormError message={formError} />
      <Button type="submit" className="w-full" disabled={localPending}>
        {localPending ? <Loader2 className="animate-spin" /> : <User />}
        {t('settings:account.createAccount')}
      </Button>
    </form>
  ) : (
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
        <p className="text-muted-foreground mt-2">
          {needsSetup ? t('pages:login.createAccountHeading') : t('pages:login.signInHeading')}
        </p>
      </div>

      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            {needsSetup ? t('settings:account.createAccount') : t('common:actions.signIn')}
          </CardTitle>
          <CardDescription>
            {needsSetup
              ? t('pages:login.createAccountDescription')
              : t('pages:login.signInDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {oidcError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{oidcError}</AlertDescription>
            </Alert>
          )}

          {authStep === 'plex-waiting' ? (
            <div className="space-y-4">
              <div className="bg-muted/50 rounded-lg p-4 text-center">
                <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-[#E5A00D]" />
                <p className="text-sm font-medium">{t('pages:login.waitingForPlex')}</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {t('pages:login.completeInPopup')}
                </p>
                {plexAuthUrl && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    onClick={() => window.open(plexAuthUrl, '_blank')}
                    className="mt-2 h-auto gap-1 p-0"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {t('pages:login.reopenPlexLogin')}
                  </Button>
                )}
              </div>
              <Button variant="ghost" className="w-full" onClick={resetPlexAuth}>
                {t('common:actions.cancel')}
              </Button>
            </div>
          ) : (
            <>
              {showPlex && (
                <Button className={`w-full ${PLEX_COLOR} text-white`} onClick={handlePlexLogin}>
                  <MediaServerIcon type="plex" className="h-4 w-4" />
                  {needsSetup
                    ? t('settings:plex.signUpWithPlex')
                    : t('settings:plex.signInWithPlex')}
                </Button>
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

      <p className="text-muted-foreground mt-6 text-center text-xs">
        {needsSetup ? t('pages:login.setupNote') : t('pages:login.tagline')}
      </p>
    </div>
  );
}
