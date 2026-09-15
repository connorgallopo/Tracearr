import { useState, useCallback, useRef } from 'react';
import type { TailscaleInfo } from '@tracearr/shared';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { AutosaveTextField } from '@/components/ui/autosave-field';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { BetaBadge } from '@/components/settings/shared/BetaBadge';
import { TooltipIconButton } from '@/components/settings/shared/TooltipIconButton';
import {
  Globe,
  Loader2,
  ExternalLink,
  CheckCircle2,
  Info,
  XCircle,
  RefreshCw,
  ChevronDown,
  AlertTriangle,
} from 'lucide-react';
import { BASE_URL } from '@/lib/basePath';
import { cn } from '@/lib/utils';
import {
  useSettings,
  useTailscaleStatus,
  useTailscaleLogs,
  useEnableTailscale,
  useDisableTailscale,
  useResetTailscale,
} from '@/hooks/queries';
import { useDebouncedSave, TEXT_INPUT_DELAY } from '@/hooks/useDebouncedSave';

function ExternalUrlCard() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: settings } = useSettings();
  const externalUrlField = useDebouncedSave('externalUrl', settings?.externalUrl, {
    delay: TEXT_INPUT_DELAY,
  });

  const externalUrl = externalUrlField.value ?? '';
  const isLocalhost = externalUrl.includes('localhost') || externalUrl.includes('127.0.0.1');
  const isHttp = externalUrl.startsWith('http://') && !isLocalhost;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5" />
          {t('general.externalAccess')}
        </CardTitle>
        <CardDescription>{t('general.externalAccessDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <AutosaveTextField
            id="externalUrl"
            label={t('general.externalUrl')}
            description={t('general.externalUrlDesc')}
            placeholder={t('general.externalUrlPlaceholder')}
            value={externalUrl}
            onChange={externalUrlField.setValue}
            status={externalUrlField.status}
            errorMessage={externalUrlField.errorMessage}
            onRetry={externalUrlField.retry}
            onReset={externalUrlField.reset}
            trailing={
              <Button
                variant="outline"
                onClick={() => {
                  let detected = window.location.origin;
                  if (import.meta.env.DEV) {
                    detected = detected.replace(':5173', ':3000');
                  }
                  externalUrlField.setValue(detected);
                  setTimeout(() => externalUrlField.saveNow(), 0);
                }}
              >
                {t('general.detect')}
              </Button>
            }
          />

          {isLocalhost && (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertDescription>{t('general.localhostWarning')}</AlertDescription>
            </Alert>
          )}
          {isHttp && (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertDescription>{t('general.iosHttpWarning')}</AlertDescription>
            </Alert>
          )}
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

function TailscaleLogo({ className }: { className?: string }) {
  return (
    <>
      <img
        src={`${BASE_URL}images/tailscale-dark.svg`}
        alt=""
        className={`dark:hidden ${className}`}
      />
      <img
        src={`${BASE_URL}images/tailscale-light.svg`}
        alt=""
        className={`hidden dark:block ${className}`}
      />
    </>
  );
}

function TailnetFacts({ status }: { status: TailscaleInfo }) {
  const { t } = useTranslation('settings');

  const facts: { label: string; value: React.ReactNode }[] = [
    ...(status.tailnetName ? [{ label: 'Tailnet', value: status.tailnetName }] : []),
    ...(status.hostname ? [{ label: t('tailscale.hostname'), value: status.hostname }] : []),
    { label: 'Tailnet IP', value: status.tailnetIp },
    ...(status.dnsName ? [{ label: t('tailscale.dnsName'), value: status.dnsName }] : []),
    ...(status.tailnetUrl
      ? [
          {
            label: t('tailscale.tailnetUrl'),
            value: (
              <a
                href={status.tailnetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {status.tailnetUrl}
              </a>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="@container/tailnet">
      <dl className="grid gap-x-6 gap-y-2 text-sm @md/tailnet:grid-cols-[auto_minmax(0,1fr)]">
        {facts.map((fact) => (
          <div key={fact.label} className="contents">
            <dt className="text-muted-foreground">{fact.label}</dt>
            <dd className="font-mono text-xs break-all">{fact.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TailscaleCard() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: status, isLoading, refetch } = useTailscaleStatus();
  const enableMutation = useEnableTailscale();
  const disableMutation = useDisableTailscale();
  const resetMutation = useResetTailscale();
  const [hostname, setHostname] = useState('');
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const isActive = status?.status !== undefined && status.status !== 'disabled';
  const { data: logs } = useTailscaleLogs(showLogs && isActive);
  const authUrl = status?.authUrl;

  const handleRefresh = useCallback(() => {
    setRefreshed(true);
    void refetch();
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => setRefreshed(false), 600);
  }, [refetch]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-80" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  // Binary not available (not running in official Docker image)
  if (!status?.available) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TailscaleLogo className="h-5 w-5" />
            {t('tailscale.title')}
            <BetaBadge />
          </CardTitle>
          <CardDescription>{t('tailscale.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <Info />
            <AlertDescription>{t('tailscale.notAvailable')}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <TooltipProvider delayDuration={100}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TailscaleLogo className="h-5 w-5" />
            {t('tailscale.title')}
            <BetaBadge />
            {status.status !== 'disabled' && (
              <TooltipIconButton
                label={t('common:actions.refresh')}
                icon={RefreshCw}
                onClick={handleRefresh}
                disabled={refreshed}
                size="icon-xs"
                iconClassName={cn(
                  'size-3.5 transition-opacity duration-300',
                  refreshed && 'opacity-30'
                )}
              />
            )}
          </CardTitle>
          <CardDescription>{t('tailscale.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Disabled state */}
          {status.status === 'disabled' && (
            <div className="space-y-4">
              <p className="text-muted-foreground text-sm">{t('tailscale.disabledDescription')}</p>
              <Field className="max-w-sm">
                <FieldLabel htmlFor="ts-hostname">{t('tailscale.hostnameLabel')}</FieldLabel>
                <Input
                  id="ts-hostname"
                  placeholder="tracearr"
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value.replace(/[^a-zA-Z0-9-]/g, ''))}
                  pattern="^[a-zA-Z0-9-]*$"
                />
                <FieldDescription>{t('tailscale.hostnameHint')}</FieldDescription>
              </Field>
              <div className="flex gap-2">
                <Button
                  onClick={() => enableMutation.mutate(hostname || undefined)}
                  disabled={enableMutation.isPending}
                >
                  {enableMutation.isPending && <Loader2 className="animate-spin" />}
                  {t('tailscale.enable')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowResetConfirm(true)}
                  disabled={resetMutation.isPending}
                >
                  {t('common:actions.reset')}
                </Button>
              </div>
            </div>
          )}

          {/* Starting state */}
          {status.status === 'starting' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-muted-foreground">{t('tailscale.starting')}</span>
              </div>
              <Button
                variant="destructive"
                onClick={() => disableMutation.mutate()}
                disabled={disableMutation.isPending}
              >
                {t('common:actions.cancel')}
              </Button>
            </div>
          )}

          {/* Awaiting auth state */}
          {status.status === 'awaiting_auth' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-muted-foreground">{t('tailscale.awaitingAuth')}</span>
              </div>
              <div className="flex gap-2">
                {authUrl && (
                  <Button
                    variant="default"
                    onClick={() => window.open(authUrl, '_blank', 'noopener,noreferrer')}
                  >
                    <ExternalLink />
                    {t('tailscale.authorize')}
                  </Button>
                )}
                <Button
                  variant="destructive"
                  onClick={() => disableMutation.mutate()}
                  disabled={disableMutation.isPending}
                >
                  {t('common:actions.cancel')}
                </Button>
              </div>
            </div>
          )}

          {/* Connected state */}
          {status.status === 'connected' && (
            <div className="space-y-4">
              <div className="text-success flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4" />
                <span>{t('tailscale.connected')}</span>
              </div>
              <TailnetFacts status={status} />

              <Button variant="destructive" onClick={() => setShowDisableConfirm(true)}>
                {t('tailscale.disable')}
              </Button>
            </div>
          )}

          {/* Stopping state */}
          {status.status === 'stopping' && (
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-muted-foreground">{t('tailscale.stopping')}</span>
            </div>
          )}

          {/* Error state */}
          {status.status === 'error' && (
            <div className="space-y-4">
              <Alert variant="destructive">
                <XCircle />
                <AlertDescription>{status.error || t('tailscale.unknownError')}</AlertDescription>
              </Alert>
              <div className="flex gap-2">
                <Button
                  onClick={() => enableMutation.mutate(hostname || undefined)}
                  disabled={enableMutation.isPending}
                >
                  {enableMutation.isPending && <Loader2 className="animate-spin" />}
                  {t('common:actions.retry')}
                </Button>
                <Button variant="destructive" onClick={() => setShowDisableConfirm(true)}>
                  {t('tailscale.disable')}
                </Button>
              </div>
            </div>
          )}

          {/* Collapsible logs section */}
          {isActive && (
            <div className="border-t pt-3">
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
                onClick={() => setShowLogs((v) => !v)}
                aria-expanded={showLogs}
                aria-controls="ts-logs"
              >
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${showLogs ? '' : '-rotate-90'}`}
                />
                {showLogs ? t('tailscale.hideLogs') : t('tailscale.showLogs')}
              </button>
              {showLogs && (
                <pre
                  id="ts-logs"
                  className="bg-muted mt-2 h-96 max-h-[48rem] min-h-24 resize-y overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap"
                >
                  {logs || t('tailscale.noLogs')}
                </pre>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={showDisableConfirm}
        onOpenChange={setShowDisableConfirm}
        title={t('tailscale.disableConfirmTitle')}
        description={t('tailscale.disableConfirmDescription')}
        confirmLabel={t('tailscale.disable')}
        onConfirm={() => {
          disableMutation.mutate();
          setShowDisableConfirm(false);
        }}
        isLoading={disableMutation.isPending}
        variant="destructive"
      />

      <ConfirmDialog
        open={showResetConfirm}
        onOpenChange={setShowResetConfirm}
        title={t('tailscale.resetConfirmTitle')}
        description={t('tailscale.resetConfirmDescription')}
        confirmLabel={t('common:actions.reset')}
        onConfirm={() => {
          resetMutation.mutate();
          setShowResetConfirm(false);
        }}
        isLoading={resetMutation.isPending}
        variant="destructive"
      />
    </TooltipProvider>
  );
}

export function RemoteAccess() {
  const { t } = useTranslation('settings');

  return (
    <SettingsSection title={t('nav.sections.remote')} description={t('nav.descriptions.remote')}>
      <ExternalUrlCard />
      <TailscaleCard />
    </SettingsSection>
  );
}
