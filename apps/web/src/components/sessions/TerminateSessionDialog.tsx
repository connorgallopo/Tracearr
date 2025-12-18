import { useState } from 'react';
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
  username: string;
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
  username,
}: TerminateSessionDialogProps) {
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Terminate Stream</DialogTitle>
          <DialogDescription>
            Stop &ldquo;{mediaTitle}&rdquo; for @{username}?
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reason">Message to user (optional)</Label>
          <Input
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g., Please don't share your account"
            maxLength={500}
          />
          <p className="text-muted-foreground text-xs">
            This message will be shown to them during playback
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={terminateSession.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleTerminate}
            disabled={terminateSession.isPending}
          >
            {terminateSession.isPending ? 'Terminating...' : 'Kill Stream'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
