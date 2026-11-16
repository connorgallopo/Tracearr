import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTerminateSession } from '@/hooks/queries';

interface TerminateSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  mediaTitle: string;
  name: string;
}

/**
 * Confirmation dialog for terminating a streaming session
 * Includes optional reason field that is shown to the user
 */
export function TerminateSessionDialog({
  open,
  onOpenChange,
  sessionId,
  mediaTitle,
  name,
}: TerminateSessionDialogProps) {
  const { t } = useTranslation(['pages', 'common']);
  const [reason, setReason] = useState('');
  const terminateSession = useTerminateSession();

  const handleTerminate = () => {
    terminateSession.mutate(
      { sessionId, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          setReason('');
          onOpenChange(false);
        },
      }
    );
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setReason('');
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{t('terminateStream.title')}</DialogTitle>
          <DialogDescription>
            {t('terminateStream.stopMediaFor', { mediaTitle, name })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reason">{t('terminateStream.messageLabel')}</Label>
          <Input
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('terminateStream.messagePlaceholder')}
            maxLength={500}
          />
          <p className="text-muted-foreground text-xs">{t('terminateStream.messageHint')}</p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={terminateSession.isPending}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={handleTerminate}
            disabled={terminateSession.isPending}
          >
            {terminateSession.isPending
              ? t('terminateStream.terminating')
              : t('automations.actions.kill_stream.label')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
