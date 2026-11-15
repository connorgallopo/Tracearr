import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, Server as ServerIcon, XCircle } from 'lucide-react';
import { SERVER_PROFILES, assertNever } from '@tracearr/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SignInAgainAlert, SignInFailedAlert } from '@/components/auth/AuthFormError';
import { PlexServerSelector } from '@/components/auth/PlexServerSelector';
import { TofaServerPicker, TofaSignInButton, TofaWaiting } from '@/components/auth/TofaSignIn';
import { holdsApiKey, type ApiKeyServerType } from '@/lib/serverType';
import { LinkPlexAccountPrompt } from './linkPlexAccount';
import type { AddServerForm, PlexAccountOption } from './useAddServer';

const SERVER_URL_HELP = {
  jellyfin: 'servers.serverUrlHelpJellyfin',
  emby: 'servers.serverUrlHelpEmby',
  tofa: 'servers.serverUrlHelpTofa',
} as const satisfies Record<ApiKeyServerType, string>;

export const API_KEY_HELP = {
  jellyfin: 'servers.apiKeyHelpJellyfin',
  emby: 'servers.apiKeyHelpEmby',
  tofa: 'servers.apiKeyHelpTofa',
} as const satisfies Record<ApiKeyServerType, string>;

export const SERVER_URL_PLACEHOLDER = {
  jellyfin: 'servers.serverUrlPlaceholder',
  emby: 'servers.serverUrlPlaceholder',
  tofa: 'servers.serverUrlPlaceholderTofa',
} as const satisfies Record<ApiKeyServerType, string>;

export const PUBLIC_URL_PLACEHOLDER: Partial<Record<ApiKeyServerType, string>> = {
  jellyfin: 'https://jellyfin.example.com',
  emby: 'https://emby.example.com',
};

function PlexAccountSelect({
  accounts,
  value,
  onChange,
  label,
  description,
  placeholder,
}: {
  accounts: PlexAccountOption[];
  value: string | null;
  onChange: (id: string) => void;
  label: string;
  description?: string;
  placeholder?: string;
}) {
  const { t } = useTranslation('settings');

  return (
    <Field className="max-w-sm">
      <FieldLabel htmlFor="plex-account">{label}</FieldLabel>
      <Select value={value ?? ''} onValueChange={onChange}>
        <SelectTrigger id="plex-account" className="w-full" aria-label={label}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {account.plexUsername ?? account.plexEmail ?? t('servers.plexAccount')}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}

export function ConnectServerButton({ form }: { form: AddServerForm }) {
  const { t } = useTranslation(['settings', 'common']);

  return (
    <Button onClick={() => void form.connect()} disabled={form.isConnecting}>
      {form.isConnecting ? (
        <>
          <Loader2 className="animate-spin" />
          {t('common:states.connecting')}
        </>
      ) : (
        t('servers.connectServer')
      )}
    </Button>
  );
}

/** tofa's sign-in, its server list, and the link to type a URL and API key instead. */
function TofaSignInFields({ form, inlineCancel }: { form: AddServerForm; inlineCancel: boolean }) {
  const { t } = useTranslation(['pages', 'settings']);
  const { tofa } = form;
  const server = SERVER_PROFILES.tofa.displayName;
  const manualLink = (
    <Button variant="link" className="h-auto self-start p-0" onClick={form.enterKeyFields}>
      {t('pages:tofa.manual')}
    </Button>
  );

  switch (tofa.step) {
    case 'waiting':
      return (
        <TofaWaiting
          verificationUri={tofa.verificationUri}
          userCode={tofa.userCode}
          expiresAt={tofa.expiresAt}
          {...(inlineCancel && { onCancel: tofa.cancel })}
        />
      );
    case 'select-server':
      if (tofa.error?.kind === 'timed-out') {
        return (
          <SignInAgainAlert
            title={t('pages:setup.timedOut', { server })}
            onSignInAgain={() => void tofa.start()}
          />
        );
      }
      return (
        <>
          <TofaServerPicker
            servers={tofa.servers}
            connectingTo={tofa.connectingTo}
            unreachable={tofa.unreachable}
            onConnect={(serverId, url) => void tofa.connect(serverId, url)}
          />
          {tofa.error?.kind === 'connect-failed' && (
            <Alert variant="destructive">
              <XCircle />
              <AlertDescription>
                {tofa.error.message ?? t('pages:login.serverConnectFailed')}
              </AlertDescription>
            </Alert>
          )}
        </>
      );
    case 'no-servers':
      return (
        <>
          <EmptyState
            icon={ServerIcon}
            title={t('pages:tofa.noServersTitle')}
            description={t('pages:tofa.noServers', { username: tofa.username })}
          >
            <Button variant="outline" onClick={() => void tofa.start()}>
              {t('pages:setup.checkAgain')}
            </Button>
          </EmptyState>
          {manualLink}
        </>
      );
    case 'all-connected':
      return (
        <EmptyState
          icon={ServerIcon}
          title={t('settings:servers.allServersConnected')}
          description={t('settings:servers.allServersConnectedDesc')}
        />
      );
    case 'idle':
      return (
        <>
          <SignInFailedAlert error={tofa.error} onSignInAgain={() => void tofa.start()} />
          <TofaSignInButton label={t('pages:tofa.signIn')} onClick={() => void tofa.start()} />
          {manualLink}
        </>
      );
    default:
      return assertNever(tofa.step);
  }
}

/**
 * The fields of the add-server form for whichever server type the form holds. The empty
 * Plex server list can be replaced where the surrounding page offers its own way forward, and a
 * page with a Back of its own can drop the Cancel under tofa's waiting state.
 */
export function AddServerFields({
  form,
  typeSelect,
  noPlexServers,
  inlineCancel = true,
  className,
}: {
  form: AddServerForm;
  typeSelect?: ReactNode;
  noPlexServers?: ReactNode;
  inlineCancel?: boolean;
  className?: string;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const { serverType, plexStep, plexAccounts, connectError } = form;
  const showAccountPicker = plexAccounts.length > 1;
  const auth = SERVER_PROFILES[serverType].addServerAuth;

  const accountPicker = showAccountPicker && (
    <PlexAccountSelect
      accounts={plexAccounts}
      value={form.selectedPlexAccountId}
      onChange={form.selectPlexAccount}
      label={t('servers.plexAccount')}
    />
  );

  const errorAlert = connectError && (
    <Alert variant="destructive">
      <XCircle />
      <AlertDescription>{connectError}</AlertDescription>
    </Alert>
  );

  return (
    <>
      {form.addedWithoutStop && (
        <Alert variant="warning" className="my-4">
          <AlertTriangle />
          <AlertTitle>{t('common:states.connected')}</AlertTitle>
          <AlertDescription>{t('servers.cannotStopStreams')}</AlertDescription>
        </Alert>
      )}

      <FieldGroup className={className} hidden={form.addedWithoutStop}>
        {typeSelect}

        {auth === 'plexOAuth' && (
          <>
            {(plexStep === 'loading' || plexStep === 'loading-servers') && (
              <div className="flex flex-col items-center justify-center gap-3 py-8">
                <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
                <p className="text-muted-foreground text-sm">
                  {plexStep === 'loading'
                    ? t('servers.loadingAccounts')
                    : t('servers.discoveringServers')}
                </p>
              </div>
            )}

            {plexStep === 'no-accounts' && (
              <LinkPlexAccountPrompt
                serverType={serverType}
                error={connectError}
                onLinked={form.loadPlexAccounts}
              />
            )}

            {plexStep === 'select-account' && (
              <PlexAccountSelect
                accounts={plexAccounts}
                value={form.selectedPlexAccountId}
                onChange={form.selectPlexAccount}
                label={t('servers.selectPlexAccount')}
                description={t('servers.selectAccountHelp')}
                placeholder={t('servers.chooseAccount')}
              />
            )}

            {plexStep === 'no-servers' && (
              <>
                {accountPicker}
                {noPlexServers ?? (
                  <EmptyState
                    icon={ServerIcon}
                    title={t('servers.allServersConnected')}
                    description={t('servers.allServersConnectedDesc')}
                  />
                )}
              </>
            )}

            {plexStep === 'select' && (
              <>
                {accountPicker}
                <PlexServerSelector
                  servers={form.plexServers}
                  onSelect={(uri, name, clientIdentifier) => {
                    void form.selectPlexServer(uri, name, clientIdentifier);
                  }}
                  connecting={form.connectingPlexServer !== null}
                  connectingToServer={form.connectingPlexServer}
                  showCancel={false}
                  onTestCustomUrl={form.testPlexUrl}
                />
                {errorAlert}
              </>
            )}
          </>
        )}
        {auth === 'tofaCloud' && !form.keyFields && (
          <TofaSignInFields form={form} inlineCancel={inlineCancel} />
        )}
        {form.keyFields && holdsApiKey(serverType) && (
          <>
            <Field>
              <FieldLabel htmlFor="serverUrl">{t('servers.serverUrl')}</FieldLabel>
              <Input
                id="serverUrl"
                placeholder={t(SERVER_URL_PLACEHOLDER[serverType])}
                value={form.serverUrl}
                onChange={(e) => form.setServerUrl(e.target.value)}
              />
              <FieldDescription>{t(SERVER_URL_HELP[serverType])}</FieldDescription>
            </Field>

            {SERVER_PROFILES[serverType].itemLinks === 'serverAddress' && (
              <Field>
                <FieldLabel htmlFor="publicUrl">{t('servers.publicUrl')}</FieldLabel>
                <Input
                  id="publicUrl"
                  placeholder={PUBLIC_URL_PLACEHOLDER[serverType]}
                  value={form.publicUrl}
                  onChange={(e) => form.setPublicUrl(e.target.value)}
                />
                <FieldDescription>{t('servers.publicUrlHint')}</FieldDescription>
              </Field>
            )}

            <Field>
              <FieldLabel htmlFor="serverName">{t('servers.serverName')}</FieldLabel>
              <Input
                id="serverName"
                placeholder={t('servers.serverNamePlaceholder')}
                value={form.serverName}
                onChange={(e) => form.setServerName(e.target.value)}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="apiKey">{t('common:labels.apiKey')}</FieldLabel>
              <Input
                id="apiKey"
                type="password"
                placeholder={t('servers.apiKeyPlaceholder')}
                value={form.apiKey}
                onChange={(e) => form.setApiKey(e.target.value)}
              />
              <FieldDescription>{t(API_KEY_HELP[serverType])}</FieldDescription>
            </Field>

            {errorAlert}
          </>
        )}
      </FieldGroup>
    </>
  );
}
