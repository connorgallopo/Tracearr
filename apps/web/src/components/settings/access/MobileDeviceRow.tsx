import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, formatDistanceToNow } from 'date-fns';
import { Loader2, Pencil, Smartphone, Trash2 } from 'lucide-react';
import type { MobileSession } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TooltipIconButton } from '@/components/settings/shared/TooltipIconButton';
import { useRevokeSession, useUpdateMobileSession } from '@/hooks/queries';

const PLATFORM_LABELS: Record<string, string> = { ios: 'iOS', android: 'Android' };

export function MobileDeviceRow({ session }: { session: MobileSession }) {
  const { t } = useTranslation(['settings', 'common']);
  const revokeSession = useRevokeSession();
  const updateSession = useUpdateMobileSession();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [editDeviceName, setEditDeviceName] = useState(session.deviceName);

  const trimmed = editDeviceName.trim();
  const canRename = trimmed.length > 0 && trimmed !== session.deviceName;

  return (
    <>
      <TooltipProvider delayDuration={100}>
        <Item role="listitem" variant="outline">
          <ItemMedia variant="icon">
            <Smartphone />
          </ItemMedia>

          <ItemContent>
            <ItemTitle>
              {session.deviceName}
              <Badge variant="secondary">
                {PLATFORM_LABELS[session.platform] ?? session.platform}
              </Badge>
            </ItemTitle>
            <ItemDescription>
              {t('mobile.lastSeen', {
                when: formatDistanceToNow(new Date(session.lastSeenAt), { addSuffix: true }),
              })}
            </ItemDescription>
            <p className="text-muted-foreground text-xs">
              {t('mobile.connectedOn', {
                date: format(new Date(session.createdAt), 'MMM d, yyyy'),
              })}
            </p>
          </ItemContent>

          <ItemActions>
            <TooltipIconButton
              label={t('mobile.renameDevice')}
              icon={Pencil}
              onClick={() => {
                setEditDeviceName(session.deviceName);
                setShowRenameDialog(true);
              }}
            />
            <TooltipIconButton
              label={t('mobile.removeDevice')}
              icon={Trash2}
              onClick={() => setShowDeleteConfirm(true)}
              iconClassName="text-destructive"
            />
          </ItemActions>
        </Item>
      </TooltipProvider>

      <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('mobile.renameDevice')}</DialogTitle>
            <DialogDescription>{t('mobile.renameDeviceDesc')}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="device-name">{t('mobile.deviceName')}</FieldLabel>
              <Input
                id="device-name"
                value={editDeviceName}
                onChange={(e) => setEditDeviceName(e.target.value)}
                placeholder={t('mobile.deviceNamePlaceholder')}
                maxLength={100}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRenameDialog(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              disabled={updateSession.isPending || !canRename}
              onClick={() => {
                updateSession.mutate(
                  { id: session.id, deviceName: trimmed },
                  { onSuccess: () => setShowRenameDialog(false) }
                );
              }}
            >
              {updateSession.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('common:states.saving')}
                </>
              ) : (
                t('common:actions.save')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title={t('mobile.removeDevice')}
        description={t('mobile.removeDeviceConfirm', { deviceName: session.deviceName })}
        confirmLabel={t('common:actions.remove')}
        isLoading={revokeSession.isPending}
        onConfirm={() => {
          revokeSession.mutate(session.id);
          setShowDeleteConfirm(false);
        }}
      />
    </>
  );
}
