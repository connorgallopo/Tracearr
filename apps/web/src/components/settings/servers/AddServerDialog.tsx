import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SERVER_TYPES, SERVER_PROFILES, type ServerType } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ImportSources } from '@/components/settings/data/Import';
import { AddServerFields, ConnectServerButton } from './AddServerFields';
import type { AddedServer, AddServerForm } from './useAddServer';
import { SERVER_DIALOG_CONTENT_CLASS } from './dialogClasses';

const DESCRIPTIONS = {
  plex: 'servers.addServerDialogDescPlex',
  jellyfin: 'servers.addServerDialogDescOther',
  emby: 'servers.addServerDialogDescOther',
  tofa: 'servers.addServerDialogDescOther',
} as const satisfies Record<ServerType, string>;

export interface AddServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: AddServerForm;
  /** The server just added; the dialog then offers its history import, as first run does. */
  added?: AddedServer | null;
}

/** First run's import step for the server just added; an import keeps running once it closes. */
function ImportHistoryStep({ server, onClose }: { server: AddedServer; onClose: () => void }) {
  const { t } = useTranslation(['pages', 'common']);
  const [started, setStarted] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);

  // The add form's focused control is gone, so the step's title takes focus, as in first run
  useEffect(() => {
    title.current?.focus();
  }, []);

  return (
    <>
      <DialogHeader className="px-6 pt-6 pr-12 pb-4">
        <DialogTitle ref={title} tabIndex={-1} className="outline-none">
          {t('pages:setup.importTitle')}
        </DialogTitle>
        <DialogDescription>{t('pages:setup.importDescription')}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto px-6 pb-6">
        <ImportSources serverId={server.id} onStarted={() => setStarted(true)} />
      </div>
      <DialogFooter className="border-t px-6 py-4">
        <Button variant={started ? 'default' : 'ghost'} onClick={onClose}>
          {started ? t('common:actions.close') : t('common:actions.skip')}
        </Button>
      </DialogFooter>
    </>
  );
}

export function AddServerDialog({ open, onOpenChange, form, added }: AddServerDialogProps) {
  const { busy } = form;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || !busy) onOpenChange(next);
      }}
    >
      <DialogContent
        className={
          added
            ? 'flex max-h-[min(85dvh,48rem)] flex-col gap-0 p-0 sm:max-w-2xl'
            : SERVER_DIALOG_CONTENT_CLASS
        }
        showCloseButton={!busy}
      >
        {added ? (
          <ImportHistoryStep server={added} onClose={() => onOpenChange(false)} />
        ) : (
          <AddServerStep form={form} onCancel={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddServerStep({ form, onCancel }: { form: AddServerForm; onCancel: () => void }) {
  const { t } = useTranslation(['settings', 'common']);
  const { serverType, isOwner, addedWithoutStop, busy } = form;
  const offeredTypes = SERVER_TYPES.filter(
    (type) => isOwner || SERVER_PROFILES[type].addServerAuth !== 'plexOAuth'
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('servers.addServer')}</DialogTitle>
        <DialogDescription>{t(DESCRIPTIONS[serverType])}</DialogDescription>
      </DialogHeader>

      <AddServerFields
        form={form}
        className="py-4"
        typeSelect={
          <Field className="max-w-sm">
            <FieldLabel htmlFor="server-type">{t('servers.serverType')}</FieldLabel>
            <Select
              value={serverType}
              onValueChange={(v) => form.changeServerType(v as ServerType)}
            >
              <SelectTrigger id="server-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {offeredTypes.map((type) => (
                  <SelectItem key={type} value={type}>
                    {SERVER_PROFILES[type].displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        }
      />

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {addedWithoutStop ? t('common:actions.close') : t('common:actions.cancel')}
        </Button>
        {addedWithoutStop && isOwner && (
          <Button onClick={form.continueAdded}>{t('common:actions.continue')}</Button>
        )}
        {form.keyFields && !addedWithoutStop && <ConnectServerButton form={form} />}
      </DialogFooter>
    </>
  );
}
