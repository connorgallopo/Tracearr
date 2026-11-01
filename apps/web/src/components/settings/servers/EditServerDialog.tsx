import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { SERVER_COLOR_PALETTE, pickServerColor, serverLocationsSchema } from '@tracearr/shared';
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
import { AutosaveSwitchField } from '@/components/ui/autosave-field';
import { ColorSwatchPicker } from '@/components/settings/shared/ColorSwatchPicker';
import { PlexServerSelector } from '@/components/auth/PlexServerSelector';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  usePlexServerConnections,
  useServerLocations,
  useUpdateServer,
  useUpdateServerLocations,
} from '@/hooks/queries';
import { useMutationSaveStatus } from '@/hooks/useMutationSaveStatus';
import { SERVER_DIALOG_CONTENT_CLASS } from './dialogClasses';
import { ServerLocationEditor } from './ServerLocationEditor';
import { draftsKey, toDrafts, toEntries, type LocationDraft } from './serverLocationDrafts';

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
  apiKey?: string;
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
  const [editApiKey, setEditApiKey] = useState('');
  const [editColor, setEditColor] = useState<string>(SERVER_COLOR_OPTIONS[3]?.hex ?? '#3B82F6');
  const [seededServer, setSeededServer] = useState<Server | null>(null);
  const isPlexServer = server?.type === 'plex';
  const locked = !!server?.historicalAt;
  const {
    data: locationData,
    isFetchedAfterMount: locationsFetched,
    isError: locationsFailed,
  } = useServerLocations(server?.id);
  const updateLocations = useUpdateServerLocations();
  const updateLibrarySync = useUpdateServer({ silent: true });
  const librarySyncStatus = useMutationSaveStatus(updateLibrarySync);
  const [drafts, setDrafts] = useState<LocationDraft[]>([]);
  const [locationBaseline, setLocationBaseline] = useState('');
  const [locationsSeededFor, setLocationsSeededFor] = useState<string | null>(null);

  const { data: connectionsData, isLoading: isLoadingConnections } = usePlexServerConnections(
    isPlexServer && !locked ? server?.id : undefined
  );

  // Re-seed from the server prop each time the dialog opens for one, rather than in an
  // effect: an effect keyed on `servers` would also re-seed (discarding in-progress edits)
  // whenever the server list refetches in the background while the dialog is open.
  if (server !== seededServer) {
    setSeededServer(server);
    setLocationsSeededFor(null);
    if (server) {
      setEditName(server.name);
      setManualUrl(server.url);
      setManualPublicUrl(server.publicUrl ?? '');
      setEditApiKey('');
      const otherColors = servers.filter((s) => s.id !== server.id).map((s) => s.color);
      setEditColor(server.color ?? pickServerColor(server.type, otherColors));
    }
  }

  // Seeded once per open, like the fields above: a background refetch must not discard edits.
  if (
    server &&
    locationData &&
    locationsFetched &&
    !locationsFailed &&
    locationsSeededFor !== server.id
  ) {
    const seeded = toDrafts(locationData.entries);
    setLocationsSeededFor(server.id);
    setDrafts(seeded);
    setLocationBaseline(draftsKey(seeded));
  }

  const locationsSeeded = server !== null && locationsSeededFor === server.id;
  const locationEntries = toEntries(drafts);
  const locationIssue = locationEntries
    ? serverLocationsSchema.safeParse({ entries: locationEntries }).error?.issues[0]?.message
    : undefined;
  const locationError = !locationEntries
    ? t('servers.location.incomplete')
    : (locationIssue ?? null);
  const hasLocationChange = locationsSeeded && draftsKey(drafts) !== locationBaseline;

  const hasNameChange = server ? editName.trim() !== server.name : false;
  const hasUrlChange = server && !locked ? manualUrl.trim() !== server.url : false;
  const hasPublicUrlChange =
    server && !isPlexServer ? manualPublicUrl.trim() !== (server.publicUrl ?? '') : false;
  const hasColorChange = server ? editColor !== (server.color ?? '') : false;
  const hasApiKeyChange = server && !isPlexServer && !locked ? editApiKey.trim().length > 0 : false;
  const hasServerChange =
    hasNameChange || hasUrlChange || hasPublicUrlChange || hasColorChange || hasApiKeyChange;
  const canSave =
    (hasServerChange || hasLocationChange) &&
    editName.trim().length > 0 &&
    (!hasLocationChange || locationError === null);
  const isSaving = isUpdating || updateLocations.isPending;

  if (!server) return null;

  const saveLocations = async () => {
    if (!hasLocationChange) return true;
    if (!locationEntries || locationError !== null) return false;
    const savedKey = draftsKey(drafts);
    try {
      await updateLocations.mutateAsync({ id: server.id, entries: locationEntries });
    } catch {
      return false;
    }
    setLocationBaseline(savedKey);
    return true;
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !isSaving && onClose()}>
      <DialogContent
        className={cn(SERVER_DIALOG_CONTENT_CLASS, 'max-h-[calc(100dvh-2rem)] overflow-y-auto')}
      >
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
              ) : connectionsData?.server && !locked ? (
                <>
                  <PlexServerSelector
                    servers={[connectionsData.server]}
                    onSelect={async (uri, _name, clientIdentifier) => {
                      if (!(await saveLocations())) return;
                      onUpdate({
                        name: hasNameChange ? editName : undefined,
                        url: uri,
                        clientIdentifier,
                        color: hasColorChange ? editColor : undefined,
                      });
                    }}
                    connecting={isSaving || (hasLocationChange && locationError !== null)}
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
                <>
                  <Input
                    id="edit-url"
                    value={manualUrl}
                    onChange={(e) => setManualUrl(e.target.value)}
                    placeholder={t('servers.plexServerUrlPlaceholder')}
                    disabled={locked}
                  />
                  {locked && <FieldDescription>{t('servers.resumeFirst')}</FieldDescription>}
                </>
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
                  disabled={locked}
                />
                {locked && <FieldDescription>{t('servers.resumeFirst')}</FieldDescription>}
              </Field>
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
              <Field>
                <FieldLabel htmlFor="edit-api-key">{t('common:labels.apiKey')}</FieldLabel>
                <Input
                  id="edit-api-key"
                  type="password"
                  autoComplete="off"
                  value={editApiKey}
                  onChange={(e) => setEditApiKey(e.target.value)}
                  placeholder={t('servers.apiKeyKeepCurrent')}
                  disabled={locked}
                />
                <FieldDescription>
                  {locked
                    ? t('servers.resumeFirst')
                    : server.type === 'jellyfin'
                      ? t('servers.apiKeyHelpJellyfin')
                      : t('servers.apiKeyHelpEmby')}
                </FieldDescription>
              </Field>
            </>
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

          {!locked && (
            <AutosaveSwitchField
              id={`librarySyncEnabled-${server.id}`}
              label={t('servers.librarySync')}
              description={t('servers.librarySyncDesc')}
              checked={
                updateLibrarySync.isPending
                  ? (updateLibrarySync.variables?.librarySyncEnabled ?? true)
                  : (server.librarySyncEnabled ?? true)
              }
              onChange={(next) =>
                updateLibrarySync.mutate({ id: server.id, librarySyncEnabled: next })
              }
              status={librarySyncStatus}
              errorMessage={updateLibrarySync.error?.message}
              onReset={updateLibrarySync.reset}
            />
          )}

          {locationsSeeded && (
            <ServerLocationEditor
              drafts={drafts}
              onChange={setDrafts}
              syncPending={locationData?.syncPending ?? false}
              error={drafts.length > 0 ? locationError : null}
            />
          )}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            disabled={isSaving || !canSave}
            onClick={async () => {
              if (!(await saveLocations())) return;
              if (hasServerChange) {
                onUpdate({
                  name: hasNameChange ? editName.trim() : undefined,
                  url: hasUrlChange ? manualUrl.trim() : undefined,
                  color: hasColorChange ? editColor : undefined,
                  publicUrl: hasPublicUrlChange ? manualPublicUrl.trim() || null : undefined,
                  apiKey: hasApiKeyChange ? editApiKey.trim() : undefined,
                });
              } else {
                onClose();
              }
            }}
          >
            {isSaving ? (
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
