import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { updateUserIdentitySchema } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useUpdateUserIdentity } from '@/hooks/queries';

interface EditUserIdentityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A server_users id; the route resolves the identity behind it. */
  userId: string;
  currentName: string | null;
  currentContactEmail: string | null;
  username: string;
}

/** The owner's edit of a person's display name and newsletter address; only what changed is sent. */
export function EditUserIdentityDialog({
  open,
  onOpenChange,
  userId,
  currentName,
  currentContactEmail,
  username,
}: EditUserIdentityDialogProps) {
  const { t } = useTranslation(['pages', 'common']);
  const [name, setName] = useState(currentName ?? '');
  const [contactEmail, setContactEmail] = useState(currentContactEmail ?? '');
  const mutation = useUpdateUserIdentity();

  useEffect(() => {
    if (open) {
      setName(currentName ?? '');
      setContactEmail(currentContactEmail ?? '');
    }
  }, [open, currentName, currentContactEmail]);

  const nextName = name.trim() || null;
  const rawEmail = contactEmail.trim() || null;
  const emailResult = updateUserIdentitySchema.shape.contactEmail.safeParse(rawEmail);
  const emailValid = emailResult.success;
  const nextEmail = emailValid ? (emailResult.data ?? null) : rawEmail;
  const data: { name?: string | null; contactEmail?: string | null } = {
    ...(nextName !== currentName && { name: nextName }),
    ...(nextEmail !== currentContactEmail && { contactEmail: nextEmail }),
  };

  const handleSubmit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!emailValid) return;
    if (Object.keys(data).length === 0) {
      onOpenChange(false);
      return;
    }
    mutation.mutate({ id: userId, data }, { onSuccess: () => onOpenChange(false) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('userDetail.editIdentity')}</DialogTitle>
          <DialogDescription>
            {t('userDetail.editIdentityDescription', { username })}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="identity-name">{t('userDetail.displayName')}</FieldLabel>
            <Input
              id="identity-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={username}
              maxLength={255}
            />
          </Field>
          <Field data-invalid={!emailValid}>
            <FieldLabel htmlFor="identity-contact-email">{t('userDetail.contactEmail')}</FieldLabel>
            <Input
              id="identity-contact-email"
              type="email"
              value={contactEmail}
              aria-invalid={!emailValid}
              onChange={(e) => setContactEmail(e.target.value)}
              maxLength={255}
            />
            <FieldDescription>{t('userDetail.contactEmailHelp')}</FieldDescription>
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" disabled={mutation.isPending || !emailValid}>
              {mutation.isPending ? t('common:states.saving') : t('common:actions.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
