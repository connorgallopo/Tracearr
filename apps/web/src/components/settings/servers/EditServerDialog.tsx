import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { SERVER_COLOR_PALETTE, pickServerColor } from '@tracearr/shared';
import type { Server } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ColorSwatchPicker } from '@/components/settings/shared/ColorSwatchPicker';
import { PlexServerSelector } from '@/components/auth/PlexServerSelector';
import { api } from '@/lib/api';
import { usePlexServerConnections } from '@/hooks/queries';
import { SERVER_DIALOG_CONTENT_CLASS } from './dialogClasses';
import { DispatcharrFields, emptyDispatcharrForm } from './DispatcharrFields';

const SERVER_COLOR_OPTIONS = SERVER_COLOR_PALETTE.map((preset) => ({
  id: preset.hex,
  name: preset.label,
  hex: preset.hex,
}));

/** Only the fields that changed; a null publicUrl clears the address. */
export interface ServerPatch {
  name?: string;
  url?: string;
  clientIdentifier?: string;
  color?: string | null;
  publicUrl?: string | null;
  token?: string;
  username?: string;
  password?: string;
  ignoreAnonymousStreams?: boolean;
}

export function EditServerDialog({
  server,
  servers,
  onClose,
  onUpdate,
  isUpdating,
}: {
  server: Server | null;
  servers: Server[];
  onClose: () => void;
  onUpdate: (patch: ServerPatch) => void;
  isUpdating: boolean;
}) {
  const { t } = useTranslation(['settings', 'common', 'pages']);
  const [editName, setEditName] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [manualPublicUrl, setManualPublicUrl] = useState('');
  const [editColor, setEditColor] = useState<string>(SERVER_COLOR_OPTIONS[3]?.hex ?? '#3B82F6');
  const [seededServer, setSeededServer] = useState<Server | null>(null);
  const isPlexServer = server?.type === 'plex';
  const isDispatcharr = server?.type === 'dispatcharr';
  const [dispatcharr, setDispatcharr] = useState(emptyDispatcharrForm);

  const { data: connectionsData, isLoading: isLoadingConnections } = usePlexServerConnections(
    isPlexServer ? server?.id : undefined
  );

  // Re-seed from the server prop each time the dialog opens for one, rather than in an
  // effect: an effect keyed on `servers` would also re-seed (discarding in-progress edits)
  // whenever the server list refetches in the background while the dialog is open.
  if (server !== seededServer) {
    setSeededServer(server);
    if (server) {
      setEditName(server.name);
      setManualUrl(server.url);
      setManualPublicUrl(server.publicUrl ?? '');
      setDispatcharr({
        ...emptyDispatcharrForm(),
        mode: server.dispatcharrAuthMode ?? 'token',
        ignoreAnonymousStreams: server.ignoreAnonymousStreams ?? true,
      });
      const otherColors = servers.filter((s) => s.id !== server.id).map((s) => s.color);
      setEditColor(server.color ?? pickServerColor(server.type, otherColors));
    }
  }

  const hasNameChange = server ? editName.trim() !== server.name : false;
  const hasUrlChange = server ? manualUrl.trim() !== server.url : false;
  const hasPublicUrlChange =
    server && !isPlexServer && !isDispatcharr
      ? manualPublicUrl.trim() !== (server.publicUrl ?? '')
      : false;
  const hasColorChange = server ? editColor !== (server.color ?? '') : false;
  const hasAuthChange =
    isDispatcharr &&
    (dispatcharr.mode !== (server?.dispatcharrAuthMode ?? 'token') ||
      Boolean(dispatcharr.token.trim() || dispatcharr.username.trim() || dispatcharr.password));
  const hasAnonymousChange =
    isDispatcharr &&
    dispatcharr.ignoreAnonymousStreams !== (server?.ignoreAnonymousStreams ?? true);
  const authValid =
    !hasAuthChange ||
    (dispatcharr.mode === 'token'
      ? Boolean(dispatcharr.token.trim())
      : Boolean(dispatcharr.username.trim()) && Boolean(dispatcharr.password));
  const canSave =
    (hasNameChange ||
      hasUrlChange ||
      hasPublicUrlChange ||
      hasColorChange ||
      hasAuthChange ||
      hasAnonymousChange) &&
    authValid &&
    editName.trim().length > 0;

  if (!server) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={SERVER_DIALOG_CONTENT_CLASS}>
        <DialogHeader>
          <DialogTitle>{t('servers.editServer')}</DialogTitle>
          <DialogDescription>{t('servers.editServerDesc')}</DialogDescription>
        </DialogHeader>

        <FieldGroup className="py-4">
          <Field>
            <FieldLabel htmlFor="edit-name">{t('servers.serverName')}</FieldLabel>
            <Input
              id="edit-name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder={t('servers.plexServerPlaceholder')}
              maxLength={100}
            />
          </Field>

          {isPlexServer ? (
            <Field>
              <FieldTitle>{t('servers.serverUrl')}</FieldTitle>
              {isLoadingConnections ? (
                <div className="flex items-center justify-center gap-2 py-4">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="text-muted-foreground text-sm">
                    {t('servers.discoveringConnections')}
                  </span>
                </div>
              ) : connectionsData?.server ? (
                <>
                  <PlexServerSelector
                    servers={[connectionsData.server]}
                    onSelect={(uri, _name, clientIdentifier) => {
                      onUpdate({
                        name: hasNameChange ? editName : undefined,
                        url: uri,
                        clientIdentifier,
                        color: hasColorChange ? editColor : undefined,
                      });
                    }}
                    connecting={isUpdating}
                    connectingToServer={isUpdating ? server.name : null}
                    onCancel={onClose}
                    showCancel
                    onTestCustomUrl={async (uri) => {
                      const result = await api.auth.testPlexConnection({ uri });
                      return result.connection;
                    }}
                  />
                  {hasNameChange && <FieldDescription>{t('servers.updateHint')}</FieldDescription>}
                </>
              ) : (
                <Input
                  id="edit-url"
                  value={manualUrl}
                  onChange={(e) => setManualUrl(e.target.value)}
                  placeholder={t('servers.plexServerUrlPlaceholder')}
                />
              )}
            </Field>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="edit-url">{t('servers.serverUrl')}</FieldLabel>
                <Input
                  id="edit-url"
                  value={manualUrl}
                  onChange={(e) => setManualUrl(e.target.value)}
                  placeholder="http://192.168.1.100:8096"
                />
              </Field>
              {!isDispatcharr && (
                <Field>
                  <FieldLabel htmlFor="edit-public-url">{t('servers.publicUrl')}</FieldLabel>
                  <Input
                    id="edit-public-url"
                    value={manualPublicUrl}
                    onChange={(e) => setManualPublicUrl(e.target.value)}
                    placeholder="https://jellyfin.example.com"
                  />
                  <FieldDescription>{t('servers.publicUrlHint')}</FieldDescription>
                </Field>
              )}
            </>
          )}

          {isDispatcharr && (
            <DispatcharrFields value={dispatcharr} onChange={setDispatcharr} editing />
          )}
          <Field>
            <FieldTitle>{t('servers.serverColor')}</FieldTitle>
            {/* Colors saved before the palette's casing are stored lowercase. */}
            <ColorSwatchPicker
              label={t('servers.serverColor')}
              options={SERVER_COLOR_OPTIONS}
              value={editColor.toUpperCase()}
              onChange={setEditColor}
            />
            <FieldDescription>{t('servers.serverColorDesc')}</FieldDescription>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            disabled={isUpdating || !canSave}
            onClick={() => {
              onUpdate({
                name: hasNameChange ? editName.trim() : undefined,
                url: hasUrlChange ? manualUrl.trim() : undefined,
                color: hasColorChange ? editColor : undefined,
                publicUrl: hasPublicUrlChange ? manualPublicUrl.trim() || null : undefined,
                ignoreAnonymousStreams: hasAnonymousChange
                  ? dispatcharr.ignoreAnonymousStreams
                  : undefined,
                ...(hasAuthChange
                  ? dispatcharr.mode === 'token'
                    ? { token: dispatcharr.token.trim() }
                    : { username: dispatcharr.username.trim(), password: dispatcharr.password }
                  : {}),
              });
            }}
          >
            {isUpdating ? (
              <>
                <Loader2 className="animate-spin" />
                {t('servers.updating')}
              </>
            ) : (
              t('common:actions.update')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
