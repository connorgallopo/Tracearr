import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, Server as ServerIcon, XCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { PlexServerSelector } from '@/components/auth/PlexServerSelector';
import type { PlexDiscoveredServer } from '@/lib/api';
import { SERVER_DIALOG_CONTENT_CLASS } from './dialogClasses';

export type PlexDialogStep =
  'loading' | 'no-accounts' | 'select-account' | 'loading-servers' | 'no-servers' | 'select';

export interface PlexAccountOption {
  id: string;
  plexUsername: string | null;
  plexEmail: string | null;
}

export interface AddServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isOwner: boolean;
  serverType: 'plex' | 'jellyfin' | 'emby';
  onServerTypeChange: (type: 'plex' | 'jellyfin' | 'emby') => void;
  serverUrl: string;
  onServerUrlChange: (value: string) => void;
  publicUrl: string;
  onPublicUrlChange: (value: string) => void;
  serverName: string;
  onServerNameChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  isConnecting: boolean;
  connectError: string | null;
  onConnect: () => void;
  plexStep: PlexDialogStep;
  plexAccounts: PlexAccountOption[];
  selectedPlexAccountId: string | null;
  onSelectPlexAccount: (id: string) => void;
  plexServers: PlexDiscoveredServer[];
  connectingPlexServer: string | null;
  onSelectPlexServer: (serverUri: string, name: string, clientIdentifier: string) => void;
  onTestPlexUrl: React.ComponentProps<typeof PlexServerSelector>['onTestCustomUrl'];
}

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

export function AddServerDialog({
  open,
  onOpenChange,
  isOwner,
  serverType,
  onServerTypeChange,
  serverUrl,
  onServerUrlChange,
  publicUrl,
  onPublicUrlChange,
  serverName,
  onServerNameChange,
  apiKey,
  onApiKeyChange,
  isConnecting,
  connectError,
  onConnect,
  plexStep,
  plexAccounts,
  selectedPlexAccountId,
  onSelectPlexAccount,
  plexServers,
  connectingPlexServer,
  onSelectPlexServer,
  onTestPlexUrl,
}: AddServerDialogProps) {
  const { t } = useTranslation(['settings', 'common']);
  const showAccountPicker = plexAccounts.length > 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={SERVER_DIALOG_CONTENT_CLASS}>
        <DialogHeader>
          <DialogTitle>{t('servers.addServer')}</DialogTitle>
          <DialogDescription>
            {serverType === 'plex'
              ? t('servers.addServerDialogDescPlex')
              : t('servers.addServerDialogDescOther')}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="py-4">
          <Field className="max-w-sm">
            <FieldLabel htmlFor="server-type">{t('servers.serverType')}</FieldLabel>
            <Select
              value={serverType}
              onValueChange={(v) => onServerTypeChange(v as 'plex' | 'jellyfin' | 'emby')}
            >
              <SelectTrigger id="server-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {isOwner && <SelectItem value="plex">Plex</SelectItem>}
                <SelectItem value="jellyfin">Jellyfin</SelectItem>
                <SelectItem value="emby">Emby</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {serverType === 'plex' ? (
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
                <Alert variant="warning">
                  <AlertTriangle />
                  <AlertDescription>
                    <span className="font-medium">{t('servers.noPlexAccountsLinked')}</span>
                    <span>{t('servers.noPlexAccountsLinkedHint')}</span>
                    {connectError && <span className="text-destructive">{connectError}</span>}
                  </AlertDescription>
                </Alert>
              )}

              {plexStep === 'select-account' && (
                <PlexAccountSelect
                  accounts={plexAccounts}
                  value={selectedPlexAccountId}
                  onChange={onSelectPlexAccount}
                  label={t('servers.selectPlexAccount')}
                  description={t('servers.selectAccountHelp')}
                  placeholder={t('servers.chooseAccount')}
                />
              )}

              {plexStep === 'no-servers' && (
                <>
                  {showAccountPicker && (
                    <PlexAccountSelect
                      accounts={plexAccounts}
                      value={selectedPlexAccountId}
                      onChange={onSelectPlexAccount}
                      label={t('servers.plexAccount')}
                    />
                  )}
                  <EmptyState
                    icon={ServerIcon}
                    title={t('servers.allServersConnected')}
                    description={t('servers.allServersConnectedDesc')}
                  />
                </>
              )}

              {plexStep === 'select' && (
                <>
                  {showAccountPicker && (
                    <PlexAccountSelect
                      accounts={plexAccounts}
                      value={selectedPlexAccountId}
                      onChange={onSelectPlexAccount}
                      label={t('servers.plexAccount')}
                    />
                  )}
                  <PlexServerSelector
                    servers={plexServers}
                    onSelect={onSelectPlexServer}
                    connecting={connectingPlexServer !== null}
                    connectingToServer={connectingPlexServer}
                    showCancel={false}
                    onTestCustomUrl={onTestPlexUrl}
                  />
                  {connectError && (
                    <Alert variant="destructive">
                      <XCircle />
                      <AlertDescription>{connectError}</AlertDescription>
                    </Alert>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="serverUrl">{t('servers.serverUrl')}</FieldLabel>
                <Input
                  id="serverUrl"
                  placeholder={t('servers.serverUrlPlaceholder')}
                  value={serverUrl}
                  onChange={(e) => onServerUrlChange(e.target.value)}
                />
                <FieldDescription>
                  {serverType === 'jellyfin'
                    ? t('servers.serverUrlHelpJellyfin')
                    : t('servers.serverUrlHelpEmby')}
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="publicUrl">{t('servers.publicUrl')}</FieldLabel>
                <Input
                  id="publicUrl"
                  placeholder="https://jellyfin.example.com"
                  value={publicUrl}
                  onChange={(e) => onPublicUrlChange(e.target.value)}
                />
                <FieldDescription>{t('servers.publicUrlHint')}</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="serverName">{t('servers.serverName')}</FieldLabel>
                <Input
                  id="serverName"
                  placeholder={t('servers.serverNamePlaceholder')}
                  value={serverName}
                  onChange={(e) => onServerNameChange(e.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="apiKey">{t('common:labels.apiKey')}</FieldLabel>
                <Input
                  id="apiKey"
                  type="password"
                  placeholder={t('servers.apiKeyPlaceholder')}
                  value={apiKey}
                  onChange={(e) => onApiKeyChange(e.target.value)}
                />
                <FieldDescription>
                  {serverType === 'jellyfin'
                    ? t('servers.apiKeyHelpJellyfin')
                    : t('servers.apiKeyHelpEmby')}
                </FieldDescription>
              </Field>

              {connectError && (
                <Alert variant="destructive">
                  <XCircle />
                  <AlertDescription>{connectError}</AlertDescription>
                </Alert>
              )}
            </>
          )}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          {serverType !== 'plex' && (
            <Button onClick={onConnect} disabled={isConnecting}>
              {isConnecting ? (
                <>
                  <Loader2 className="animate-spin" />
                  {t('servers.connecting')}
                </>
              ) : (
                t('servers.connectServer')
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
