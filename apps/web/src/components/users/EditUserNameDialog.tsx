import { useState, useEffect } from 'react';
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
import { useUpdateUserIdentity } from '@/hooks/queries';

interface EditUserNameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  currentName: string | null;
  username: string;
}

/**
 * Dialog for editing a user's display name (identity name)
 * Only accessible to owners
 */
export function EditUserNameDialog({
  open,
  onOpenChange,
  userId,
  currentName,
  username,
}: EditUserNameDialogProps) {
  const [name, setName] = useState(currentName ?? '');
  const mutation = useUpdateUserIdentity();

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setName(currentName ?? '');
    }
  }, [open, currentName]);

  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    mutation.mutate(
      { id: userId, name: name.trim() || null },
      { onSuccess: () => onOpenChange(false) }
    );
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setName(currentName ?? '');
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Display Name</DialogTitle>
          <DialogDescription>
            Set a custom display name. Leave empty to use server username (@{username}).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="displayName">Display Name</Label>
            <Input
              id="displayName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={username}
              maxLength={255}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
