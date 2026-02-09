import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Loader2, ExternalLink, User, KeyRound } from 'lucide-react';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { api, tokenStorage } from '@/lib/api';
import type { PlexDiscoveredServer } from '@tracearr/shared';
import { LogoIcon } from '@/components/brand/Logo';
import { PlexServerSelector } from '@/components/auth/PlexServerSelector';

// Plex brand color
const PLEX_COLOR = 'bg-[#E5A00D] hover:bg-[#C88A0B]';

type AuthStep = 'initial' | 'plex-waiting' | 'server-select';

export function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation(['pages', 'common', 'settings', 'notifications']);
  const { isAuthenticated, isLoading: authLoading, refetch } = useAuth();

  // Setup status - default to false (Sign In mode) since most users are returning
  const [setupLoading, setSetupLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasPasswordAuth, setHasPasswordAuth] = useState(false);
  const [hasJellyfinServers, setHasJellyfinServers] = useState(false);

  // Auth form state - which form to show (jellyfin or local)
  // Default to Jellyfin if Jellyfin servers exist, otherwise default to local
  const [showJellyfinForm, setShowJellyfinForm] = useState(true);

  // Auth flow state
  const [authStep, setAuthStep] = useState<AuthStep>('initial');
  const [plexAuthUrl, setPlexAuthUrl] = useState<string | null>(null);
  const [plexServers, setPlexServers] = useState<PlexDiscoveredServer[]>([]);
  const [plexTempToken, setPlexTempToken] = useState<string | null>(null);
  const [connectingToServer, setConnectingToServer] = useState<string | null>(null);
  const [plexPopup, setPlexPopup] = useState<ReturnType<typeof window.open>>(null);

  // Local auth state
  const [localLoading, setLocalLoading] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');

  // Jellyfin auth state
  const [jellyfinLoading, setJellyfinLoading] = useState(false);
  const [jellyfinUsername, setJellyfinUsername] = useState('');
  const [jellyfinPassword, setJellyfinPassword] = useState('');

  // Check setup status on mount with retry logic for server restarts
  useEffect(() => {
    async function checkSetup() {
      const maxRetries = 3;
      const delays = [0, 1000, 2000]; // immediate, 1s, 2s

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
          }
          const status = await api.setup.status();
          setNeedsSetup(status.needsSetup);
          setHasPasswordAuth(status.hasPasswordAuth);
          setHasJellyfinServers(status.hasJellyfinServers);
          // Use the configured primary auth method
          setShowJellyfinForm(status.primaryAuthMethod === 'jellyfin');
          setSetupLoading(false);
          return; // Success - exit retry loop
        } catch {
          // Continue to next retry attempt
        }
      }

      // All retries failed - server is unavailable
      // Default to Sign In mode (needsSetup: false) since most users are returning users
      // If they actually need setup, the server will tell them when it comes back
      setNeedsSetup(false);
      setSetupLoading(false);
    }
    void checkSetup();
  }, []);

  // Redirect if already authenticated
  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      const redirectTo = searchParams.get('redirect') || '/';
      void navigate(redirectTo, { replace: true });
    }
  }, [isAuthenticated, authLoading, navigate, searchParams]);

  // Close Plex popup helper
  const closePlexPopup = () => {
    if (plexPopup && !plexPopup.closed) {
      plexPopup.close();
    }
    setPlexPopup(null);
  };

  // Poll for Plex PIN claim
  const pollPlexPin = async (pinId: string) => {
    try {
      const result = await api.auth.checkPlexPin(pinId);

      if (!result.authorized) {
        // Still waiting for PIN claim, continue polling
        setTimeout(() => void pollPlexPin(pinId), 2000);
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
      } else if (result.accessToken && result.refreshToken) {
        // User authenticated (returning or no servers)
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        void refetch();
        toast.success(t('notifications:toast.success.loggedIn.title'), {
          description: t('notifications:toast.success.loggedIn.message'),
        });
        void navigate('/');
      }
    } catch (error) {
      resetPlexAuth();
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
      const callbackUrl = `${window.location.origin}/auth/plex-callback`;
      const result = await api.auth.loginPlex(callbackUrl);
      setPlexAuthUrl(result.authUrl);

      // Navigate popup to Plex auth
      if (popup && !popup.closed) {
        popup.location.href = result.authUrl;
      }

      // Start polling
      void pollPlexPin(result.pinId);
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
      });

      if (result.accessToken && result.refreshToken) {
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        await refetch();
        toast.success(t('notifications:toast.success.loggedIn.title'), {
          description: t('pages:login.connectedTo', { name: serverName }),
        });
        void navigate('/');
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

  // Handle local signup
  const handleLocalSignup = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLocalLoading(true);

    try {
      const result = await api.auth.signup({
        email: email.trim(),
        username: username.trim(),
        password,
      });

      if (result.accessToken && result.refreshToken) {
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        void refetch();
        toast.success(t('notifications:toast.success.loggedIn.title'), {
          description: t('pages:login.accountCreated'),
        });
        void navigate('/');
      }
    } catch (error) {
      toast.error(t('pages:login.signupFailed'), {
        description: error instanceof Error ? error.message : t('pages:login.createAccountFailed'),
      });
    } finally {
      setLocalLoading(false);
    }
  };

  // Handle local login
  const handleLocalLogin = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLocalLoading(true);

    try {
      const result = await api.auth.loginLocal({
        email: email.trim(),
        password,
      });

      if (result.accessToken && result.refreshToken) {
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        void refetch();
        toast.success(t('notifications:toast.success.loggedIn.title'), {
          description: t('notifications:toast.success.loggedIn.message'),
        });
        void navigate('/');
      }
    } catch (error) {
      toast.error(t('pages:login.loginFailed'), {
        description: error instanceof Error ? error.message : t('pages:login.invalidCredentials'),
      });
    } finally {
      setLocalLoading(false);
    }
  };

  // Handle Jellyfin login
  const handleJellyfinLogin = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setJellyfinLoading(true);

    try {
      const result = await api.auth.loginJellyfin({
        username: jellyfinUsername.trim(),
        password: jellyfinPassword,
      });

      if (result.accessToken && result.refreshToken) {
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        setJellyfinUsername('');
        setJellyfinPassword('');
        void refetch();
        toast.success(t('notifications:toast.success.loggedIn.title'), {
          description: t('notifications:toast.success.loggedIn.message'),
        });
        void navigate('/');
      }
    } catch (error) {
      toast.error(t('pages:login.loginFailed'), {
        description:
          error instanceof Error ? error.message : t('pages:login.jellyfinInvalidCredentials'),
      });
    } finally {
      setJellyfinLoading(false);
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

  // Server selection step (only during Plex signup)
  if (authStep === 'server-select' && plexServers.length > 0) {
    return (
      <div className="bg-background flex min-h-screen flex-col items-center justify-center p-4">
        <div className="mb-8 flex flex-col items-center text-center">
          <LogoIcon className="mb-4 h-20 w-20" />
          <h1 className="text-4xl font-bold tracking-tight">{t('pages:login.title')}</h1>
          <p className="text-muted-foreground mt-2">{t('pages:login.selectPlexServer')}</p>
        </div>

        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{t('settings:plex.selectServer')}</CardTitle>
            <CardDescription>{t('settings:plex.chooseServer')}</CardDescription>
          </CardHeader>
          <CardContent>
            <PlexServerSelector
              servers={plexServers}
              onSelect={handlePlexServerSelect}
              connecting={connectingToServer !== null}
              connectingToServer={connectingToServer}
              onCancel={resetPlexAuth}
            />
          </CardContent>
        </Card>
      </div>
    );
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
            {needsSetup ? t('settings:account.createAccount') : t('settings:account.signIn')}
          </CardTitle>
          <CardDescription>
            {needsSetup
              ? t('pages:login.createAccountDescription')
              : t('pages:login.signInDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Plex OAuth Section */}
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
              {/* Plex Login Button - Always Available */}
              <Button className={`w-full ${PLEX_COLOR} text-white`} onClick={handlePlexLogin}>
                <MediaServerIcon type="plex" className="mr-2 h-4 w-4" />
                {needsSetup ? t('settings:plex.signUpWithPlex') : t('settings:plex.signInWithPlex')}
              </Button>

              {/* Divider between Plex and other auth methods */}
              {(hasJellyfinServers || hasPasswordAuth || needsSetup) && (
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card text-muted-foreground px-2">{t('common:or')}</span>
                  </div>
                </div>
              )}

              {/* Conditional Auth Forms - Show only one at a time with transition */}
              {(hasJellyfinServers || hasPasswordAuth || needsSetup) && (
                <div className="relative min-h-[200px]">
                  {/* Jellyfin Admin Login Form */}
                  {showJellyfinForm && hasJellyfinServers && (
                    <div
                      key="jellyfin-form"
                      className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300"
                    >
                      <form onSubmit={handleJellyfinLogin} className="space-y-4">
                        <div className="space-y-2">
                          <Label htmlFor="jellyfin-username">
                            {t('settings:jellyfin.username')}
                          </Label>
                          <Input
                            id="jellyfin-username"
                            type="text"
                            placeholder={t('pages:login.jellyfinUsernamePlaceholder')}
                            value={jellyfinUsername}
                            onChange={(e) => setJellyfinUsername(e.target.value)}
                            required
                            disabled={jellyfinLoading}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="jellyfin-password">
                            {t('settings:jellyfin.password')}
                          </Label>
                          <Input
                            id="jellyfin-password"
                            type="password"
                            placeholder={t('pages:login.jellyfinPasswordPlaceholder')}
                            value={jellyfinPassword}
                            onChange={(e) => setJellyfinPassword(e.target.value)}
                            required
                            disabled={jellyfinLoading}
                          />
                          <p className="text-muted-foreground text-xs">
                            {t('pages:login.jellyfinAdminNote')}
                          </p>
                        </div>
                        <Button type="submit" className="w-full" disabled={jellyfinLoading}>
                          {jellyfinLoading ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <MediaServerIcon type="jellyfin" className="mr-2 h-4 w-4" />
                          )}
                          {t('settings:jellyfin.signInWithJellyfin')}
                        </Button>
                      </form>

                      {/* Toggle button to switch to local auth */}
                      {hasPasswordAuth && (
                        <Button
                          type="button"
                          variant="link"
                          className="text-muted-foreground hover:text-foreground mt-4 w-full text-sm transition-colors"
                          onClick={() => setShowJellyfinForm(false)}
                        >
                          {t('settings:account.useLocalAccount')}
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Local Auth Form */}
                  {!showJellyfinForm && (hasPasswordAuth || needsSetup) && (
                    <div
                      key="local-form"
                      className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300"
                    >
                      {needsSetup ? (
                        <form onSubmit={handleLocalSignup} className="space-y-4">
                          <div className="space-y-2">
                            <Label htmlFor="email">{t('settings:account.email')}</Label>
                            <Input
                              id="email"
                              type="email"
                              placeholder={t('pages:login.emailPlaceholder')}
                              value={email}
                              onChange={(e) => setEmail(e.target.value)}
                              required
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="username">{t('settings:account.displayName')}</Label>
                            <Input
                              id="username"
                              type="text"
                              placeholder={t('pages:login.displayNamePlaceholder')}
                              value={username}
                              onChange={(e) => setUsername(e.target.value)}
                              required
                              minLength={3}
                              maxLength={50}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="password">{t('settings:account.password')}</Label>
                            <Input
                              id="password"
                              type="password"
                              placeholder={t('pages:login.passwordPlaceholder')}
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              required
                              minLength={8}
                            />
                          </div>
                          <Button type="submit" className="w-full" disabled={localLoading}>
                            {localLoading ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <User className="mr-2 h-4 w-4" />
                            )}
                            {t('settings:account.createAccount')}
                          </Button>
                        </form>
                      ) : (
                        <form onSubmit={handleLocalLogin} className="space-y-4">
                          <div className="space-y-2">
                            <Label htmlFor="email">{t('settings:account.email')}</Label>
                            <Input
                              id="email"
                              type="email"
                              placeholder={t('pages:login.emailPlaceholder')}
                              value={email}
                              onChange={(e) => setEmail(e.target.value)}
                              required
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="password">{t('settings:account.password')}</Label>
                            <Input
                              id="password"
                              type="password"
                              placeholder={t('pages:login.yourPasswordPlaceholder')}
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              required
                            />
                          </div>
                          <Button type="submit" className="w-full" disabled={localLoading}>
                            {localLoading ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <KeyRound className="mr-2 h-4 w-4" />
                            )}
                            {t('settings:account.signIn')}
                          </Button>
                        </form>
                      )}

                      {/* Toggle button to switch to Jellyfin auth */}
                      {hasJellyfinServers && (
                        <Button
                          type="button"
                          variant="link"
                          className="text-muted-foreground hover:text-foreground mt-4 w-full text-sm transition-colors"
                          onClick={() => setShowJellyfinForm(true)}
                        >
                          {t('settings:account.useJellyfinAccount')}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
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
