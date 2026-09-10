import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Info, Mail, Plus } from 'lucide-react';
import type { Newsletter } from '@tracearr/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { ItemGroup } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { DestinationDialog } from '@/components/settings/destinations/DestinationDialog';
import {
  useDeleteNewsletter,
  useDestinations,
  useDuplicateNewsletter,
  useNewsletters,
  useUpdateNewsletter,
} from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { NewsletterRow } from './NewsletterRow';
import { SendNowDialog } from './newsletter/SendNowDialog';

export const NEWSLETTERS_PATH = '/settings/notifications/newsletters';

/** Shared by the header action and the empty state; each caller's own useNavigate keeps this self-contained. */
function NewNewsletterButton() {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  return (
    <Button onClick={() => void navigate(`${NEWSLETTERS_PATH}/new`)}>
      <Plus />
      {t('newsletters.new')}
    </Button>
  );
}

/** The empty state creates the SMTP destination here and lands on the new newsletter with it selected. */
function AddEmailDestinationButton() {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus />
        {t('newsletters.addEmailDestination')}
      </Button>
      {open && (
        <DestinationDialog
          open
          onOpenChange={setOpen}
          mode="create"
          initialKind="email"
          onCreated={(created) =>
            void navigate(`${NEWSLETTERS_PATH}/new`, { state: { destinationId: created.id } })
          }
        />
      )}
    </>
  );
}

function NewslettersSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function NewsletterList({ hasEmailDestination }: { hasEmailDestination: boolean }) {
  const { t } = useTranslation(['settings', 'common']);
  const navigate = useNavigate();
  const { data: newsletters, isLoading, isError, error } = useNewsletters();
  const update = useUpdateNewsletter();
  const remove = useDeleteNewsletter();
  const duplicate = useDuplicateNewsletter();
  const [deleting, setDeleting] = useState<Newsletter | null>(null);
  const [sending, setSending] = useState<Newsletter | null>(null);

  if (isLoading) {
    return <NewslettersSkeleton />;
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <Info />
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }

  const rows = newsletters ?? [];

  if (rows.length === 0) {
    return hasEmailDestination ? (
      <EmptyState
        icon={Mail}
        title={t('newsletters.empty')}
        description={t('newsletters.emptyDescription')}
      >
        <NewNewsletterButton />
      </EmptyState>
    ) : (
      <EmptyState
        icon={Mail}
        title={t('newsletters.noDestinationTitle')}
        description={t('newsletters.noDestinationDescription')}
      >
        <AddEmailDestinationButton />
      </EmptyState>
    );
  }

  return (
    <>
      <ItemGroup className="gap-2">
        {rows.map((newsletter) => (
          <NewsletterRow
            key={newsletter.id}
            newsletter={newsletter}
            toggling={update.isPending && update.variables?.id === newsletter.id}
            onToggle={(enabled) => update.mutate({ id: newsletter.id, data: { enabled } })}
            onEdit={() => void navigate(`${NEWSLETTERS_PATH}/${newsletter.id}`)}
            onDuplicate={() =>
              duplicate.mutate(newsletter.id, {
                onSuccess: (copy) => void navigate(`${NEWSLETTERS_PATH}/${copy.id}`),
              })
            }
            onDelete={() => setDeleting(newsletter)}
            extraActions={
              <DropdownMenuItem onSelect={() => setSending(newsletter)}>
                {t('newsletters.sendNow')}
              </DropdownMenuItem>
            }
          />
        ))}
      </ItemGroup>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('newsletters.deleteTitle')}
        description={t('newsletters.deleteDescription', { name: deleting?.name ?? '' })}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        isLoading={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, { onSettled: () => setDeleting(null) });
        }}
      />
      <SendNowDialog
        newsletterId={sending?.id ?? null}
        name={sending?.name ?? ''}
        timezone={sending?.timezone ?? 'UTC'}
        onOpenChange={(open) => {
          if (!open) setSending(null);
        }}
      />
    </>
  );
}

export function Newsletters() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';
  const {
    data: destinations,
    isLoading: isDestinationsLoading,
    isError: isDestinationsError,
    error: destinationsError,
  } = useDestinations(isOwner);
  const hasEmailDestination = (destinations ?? []).some((d) => d.type === 'email' && d.enabled);
  const destinationsSettled = !isDestinationsLoading && !isDestinationsError;

  return (
    <SettingsSection
      title={t('nav.sections.newsletters')}
      description={t('nav.descriptions.newsletters')}
      actions={isOwner && destinationsSettled && hasEmailDestination && <NewNewsletterButton />}
    >
      {!isOwner ? (
        <Alert>
          <Info />
          <AlertDescription>{t('newsletters.ownerOnly')}</AlertDescription>
        </Alert>
      ) : isDestinationsLoading ? (
        <NewslettersSkeleton />
      ) : isDestinationsError ? (
        <Alert variant="destructive">
          <Info />
          <AlertDescription>{destinationsError.message}</AlertDescription>
        </Alert>
      ) : (
        <NewsletterList hasEmailDestination={hasEmailDestination} />
      )}
    </SettingsSection>
  );
}
