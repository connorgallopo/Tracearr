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
import { AddServerFields, ConnectServerButton } from './AddServerFields';
import type { AddServerForm } from './useAddServer';
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
}

export function AddServerDialog({ open, onOpenChange, form }: AddServerDialogProps) {
  const { t } = useTranslation(['settings', 'common']);
  const { serverType, isOwner, addedWithoutStop } = form;
  const offeredTypes = SERVER_TYPES.filter(
    (type) => isOwner || SERVER_PROFILES[type].addServerAuth !== 'plexOAuth'
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={SERVER_DIALOG_CONTENT_CLASS}>
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {addedWithoutStop ? t('common:actions.close') : t('common:actions.cancel')}
          </Button>
          {form.keyFields && !addedWithoutStop && <ConnectServerButton form={form} />}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
