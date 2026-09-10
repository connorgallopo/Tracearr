import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { Clock, Info, Loader2, LogOut, Plus, Smartphone } from 'lucide-react';
import type { MobileQRPayload } from '@tracearr/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ItemGroup } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { MobileDeviceRow } from '@/components/settings/access/MobileDeviceRow';
import { BASE_PATH, BASE_URL } from '@/lib/basePath';
import {
  useDisableMobile,
  useEnableMobile,
  useGeneratePairToken,
  useMobileConfig,
  useRevokeMobileSessions,
  useSettings,
} from '@/hooks/queries';

const GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=com.tracearr.mobile';
const APP_STORE_URL = 'https://apps.apple.com/us/app/tracearr/id6755941553';

function StoreBadges() {
  const { t } = useTranslation('settings');

  return (
    <div className="flex flex-wrap items-center justify-center gap-4">
      <a
        href={GOOGLE_PLAY_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="transition-opacity hover:opacity-80"
      >
        <img
          src={`${BASE_URL}images/store-badges/google-play.svg`}
          alt={t('mobile.getOnGooglePlay')}
          height={40}
          className="h-[40px] w-auto"
        />
      </a>
      <a
        href={APP_STORE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="transition-opacity hover:opacity-80"
      >
        <img
          src={`${BASE_URL}images/store-badges/app-store.svg`}
          alt={t('mobile.downloadOnAppStore')}
          height={40}
          className="h-[40px] w-auto"
        />
      </a>
    </div>
  );
}

export function MobileDevices() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: config, isLoading } = useMobileConfig();
  const { data: settings } = useSettings();
  const enableMobile = useEnableMobile();
  const disableMobile = useDisableMobile();
  const generatePairToken = useGeneratePairToken();
  const revokeMobileSessions = useRevokeMobileSessions();

  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);
  const [showQRDialog, setShowQRDialog] = useState(false);
  const [pairToken, setPairToken] = useState<{ token: string; expiresAt: string } | null>(null);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!pairToken?.expiresAt) {
      return;
    }

    const updateTimer = () => {
      const now = Date.now();
      const expiresAt = new Date(pairToken.expiresAt).getTime();
      const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
      setTimeLeft(remaining);

      if (remaining === 0) {
        setPairToken(null);
        setShowQRDialog(false);
        setTimeLeft(null);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [pairToken]);

  const handleAddDevice = async () => {
    try {
      const token = await generatePairToken.mutateAsync();
      if (token?.token && token?.expiresAt) {
        setPairToken(token);
        setShowQRDialog(true);
      } else {
        console.error('Invalid token response:', token);
        toast.error(t('mobile.failedToGenerateToken'), {
          description: 'Received invalid token data from server.',
        });
      }
    } catch (err) {
      // Error already handled by mutation's onError, but log for support
      console.error('Token generation error:', err);
    }
  };

  const getServerUrl = (): string => {
    if (settings?.externalUrl) {
      return settings.externalUrl;
    }
    let serverUrl: string = window.location.origin as string;
    if (import.meta.env.DEV) {
      serverUrl = serverUrl.replace(':5173', ':3000');
    }
    if (BASE_PATH) {
      serverUrl += BASE_PATH;
    }
    return serverUrl;
  };

  const getQRData = (): string => {
    if (!pairToken?.token) return '';
    const payload: MobileQRPayload = {
      url: getServerUrl(),
      token: pairToken.token,
      name: config?.serverName ?? 'Tracearr',
    };
    // Convert to UTF-8 bytes then base64 to handle non-ASCII characters (e.g., umlauts)
    const jsonString = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(jsonString);
    const encoded = btoa(String.fromCharCode(...bytes));
    return `tracearr://pair?data=${encoded}`;
  };

  const formatTimeLeft = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const deviceCount = config?.sessions?.length ?? 0;
  const maxDevices = config?.maxDevices ?? 5;

  return (
    <SettingsSection
      title={t('nav.sections.mobile')}
      description={t('nav.descriptions.mobile')}
      actions={
        config?.isEnabled ? (
          <Button
            onClick={() => void handleAddDevice()}
            disabled={deviceCount >= maxDevices || generatePairToken.isPending}
          >
            {generatePairToken.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            {t('mobile.addDevice')}
          </Button>
        ) : undefined
      }
    >
      {!settings?.externalUrl && (
        <Alert>
          <Info />
          <AlertDescription>
            {t('mobile.externalUrlBanner')}{' '}
            <NavLink
              to="/settings/access/remote"
              className="font-medium underline underline-offset-2"
            >
              {t('mobile.externalUrlBannerLink')}
            </NavLink>{' '}
            {t('mobile.externalUrlBannerSuffix')}
          </AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : !config?.isEnabled ? (
        <EmptyState
          icon={Smartphone}
          title={t('mobile.mobileAccessDisabled')}
          description={t('mobile.mobileAccessDisabledDesc')}
        >
          <Button onClick={() => enableMobile.mutate()} disabled={enableMobile.isPending}>
            {enableMobile.isPending ? (
              <>
                <Loader2 className="animate-spin" />
                {t('mobile.enabling')}
              </>
            ) : (
              t('mobile.enableMobileAccess')
            )}
          </Button>
          <StoreBadges />
        </EmptyState>
      ) : config.sessions.length === 0 ? (
        <EmptyState
          icon={Smartphone}
          title={t('mobile.noDevices')}
          description={t('mobile.noDevicesDesc')}
        >
          <StoreBadges />
        </EmptyState>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            {t('mobile.devicesConnected', { current: deviceCount, max: maxDevices })}
          </p>
          {config.pendingTokens > 0 && (
            <p className="text-muted-foreground text-xs">
              {t('mobile.pendingTokens', { count: config.pendingTokens })}
            </p>
          )}
          <ItemGroup className="gap-4">
            {config.sessions.map((session) => (
              <MobileDeviceRow key={session.id} session={session} />
            ))}
          </ItemGroup>
        </>
      )}

      {config?.isEnabled && (
        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button variant="outline" onClick={() => setShowRevokeConfirm(true)}>
            <LogOut />
            {t('mobile.revokeAllSessions')}
          </Button>
          <Button variant="outline" onClick={() => setShowDisableConfirm(true)}>
            {t('mobile.disableMobileAccess')}
          </Button>
        </div>
      )}

      <Dialog
        open={showQRDialog}
        onOpenChange={(open) => {
          setShowQRDialog(open);
          if (!open) {
            setPairToken(null);
            setTimeLeft(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('mobile.pairNewDevice')}</DialogTitle>
            <DialogDescription>{t('mobile.pairNewDeviceDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {pairToken && (
              <>
                <div className="flex flex-col items-center gap-4">
                  <div className="rounded-lg border bg-white p-4">
                    <QRCodeSVG value={getQRData()} size={200} level="M" marginSize={0} />
                  </div>
                  {timeLeft !== null && (
                    <div className="text-muted-foreground flex items-center gap-2 text-sm">
                      <Clock className="h-4 w-4" />
                      <span>{t('mobile.expiresIn', { time: formatTimeLeft(timeLeft) })}</span>
                    </div>
                  )}
                </div>

                <Field>
                  <FieldLabel htmlFor="pair-token">{t('mobile.oneTimePairToken')}</FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      id="pair-token"
                      readOnly
                      value={pairToken.token}
                      className="font-mono text-xs"
                    />
                    <CopyButton value={pairToken.token} label={t('mobile.copyToken')} />
                  </div>
                  <FieldDescription>{t('mobile.tokenExpiryNote')}</FieldDescription>
                </Field>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setShowQRDialog(false);
                setPairToken(null);
                setTimeLeft(null);
              }}
            >
              {t('mobile.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={showDisableConfirm}
        onOpenChange={setShowDisableConfirm}
        title={t('mobile.disableMobileAccess')}
        description={t('mobile.disableMobileAccessConfirm')}
        confirmLabel={t('mobile.disable')}
        isLoading={disableMobile.isPending}
        onConfirm={() => {
          disableMobile.mutate();
          setShowDisableConfirm(false);
        }}
      />

      <ConfirmDialog
        open={showRevokeConfirm}
        onOpenChange={setShowRevokeConfirm}
        title={t('mobile.revokeAll')}
        description={t('mobile.revokeAllConfirm')}
        confirmLabel={t('mobile.revokeAllSessions')}
        isLoading={revokeMobileSessions.isPending}
        onConfirm={() => {
          revokeMobileSessions.mutate();
          setShowRevokeConfirm(false);
        }}
      />
    </SettingsSection>
  );
}
