import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import type { OwnerLinkCandidate, OwnerLinkServer, Server } from '@tracearr/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { UserCell } from '@/components/users/UserCell';
import { useLinkOwnerAccount } from '@/hooks/queries';
import { safeFormatDistanceToNow } from '@/lib/dateFormat';

interface OwnerLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: Server;
  link: OwnerLinkServer;
}

// The one administrator is almost always the person running the server.
function soleAdmin(candidates: OwnerLinkCandidate[]): OwnerLinkCandidate | undefined {
  const admins = candidates.filter((c) => c.isServerAdmin && c.blockedReason === null);
  return admins.length === 1 ? admins[0] : undefined;
}

export function OwnerLinkDialog({ open, onOpenChange, server, link }: OwnerLinkDialogProps) {
  const { t } = useTranslation(['settings', 'common']);
  const [selected, setSelected] = useState(() => soleAdmin(link.candidates));
  const [typed, setTyped] = useState('');
  const linkAccount = useLinkOwnerAccount();

  const confirmed = selected !== undefined && typed.trim() === selected.username;

  const details = (candidate: OwnerLinkCandidate) => {
    if (candidate.blockedReason === 'other_accounts') {
      return [t('servers.ownerAccount.dialog.otherAccounts')];
    }
    if (candidate.blockedReason === 'signs_in') return [t('servers.ownerAccount.dialog.signsIn')];
    return [
      ...(candidate.isServerAdmin ? [t('servers.ownerAccount.dialog.admin')] : []),
      candidate.lastActivityAt === null
        ? t('servers.ownerAccount.dialog.neverActive')
        : t('servers.ownerAccount.dialog.lastActive', {
            ago: safeFormatDistanceToNow(candidate.lastActivityAt),
          }),
    ];
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('servers.ownerAccount.dialog.title', { server: server.name })}
          </DialogTitle>
          <DialogDescription>{t('servers.ownerAccount.dialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-4">
          <Command className="rounded-md border">
            <CommandInput placeholder={t('common:search.searchUsers')} />
            <CommandList>
              <CommandEmpty>{t('common:empty.noResults')}</CommandEmpty>
              {link.candidates.map((candidate) => (
                <CommandItem
                  key={candidate.serverUserId}
                  value={candidate.username}
                  disabled={candidate.blockedReason !== null}
                  onSelect={() => {
                    setSelected(candidate);
                    setTyped('');
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <UserCell
                      serverUserId={candidate.serverUserId}
                      username={candidate.username}
                      thumbUrl={candidate.thumbUrl}
                      serverId={server.id}
                      details={details(candidate)}
                      link={false}
                    />
                  </span>
                  {selected?.serverUserId === candidate.serverUserId && (
                    <Check className="text-primary" aria-hidden="true" />
                  )}
                </CommandItem>
              ))}
            </CommandList>
          </Command>

          {selected && (
            <>
              <Alert variant="warning">
                <AlertTriangle />
                <AlertTitle>{t('servers.ownerAccount.dialog.warningTitle')}</AlertTitle>
                <AlertDescription>
                  {t('servers.ownerAccount.dialog.warning', {
                    username: selected.username,
                    context: server.type,
                  })}
                </AlertDescription>
              </Alert>
              <Field>
                <FieldLabel htmlFor="owner-link-confirm">
                  {t('servers.ownerAccount.dialog.confirmLabel', { username: selected.username })}
                </FieldLabel>
                <Input
                  id="owner-link-confirm"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            onClick={() => {
              if (!selected) return;
              linkAccount.mutate(selected.serverUserId, {
                onSuccess: () => onOpenChange(false),
              });
            }}
            disabled={!confirmed || linkAccount.isPending}
          >
            {linkAccount.isPending && <Loader2 className="animate-spin" />}
            {t('servers.ownerAccount.dialog.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
