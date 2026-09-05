import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Info, Mail, Plus } from 'lucide-react';
import type { Newsletter } from '@tracearr/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ItemGroup } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import {
  useDeleteNewsletter,
  useDestinations,
  useDuplicateNewsletter,
  useNewsletters,
  useUpdateNewsletter,
} from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { NewsletterRow } from './NewsletterRow';

export const NEWSLETTERS_PATH = '/settings/notifications/newsletters';
const DESTINATIONS_PATH = '/settings/notifications/destinations';

function NewsletterList({ hasEmailDestination }: { hasEmailDestination: boolean }) {
  const { t } = useTranslation(['settings', 'common']);
  const navigate = useNavigate();
  const { data: newsletters, isLoading, isError, error } = useNewsletters();
  const update = useUpdateNewsletter();
  const remove = useDeleteNewsletter();
  const duplicate = useDuplicateNewsletter();
  const [deleting, setDeleting] = useState<Newsletter | null>(null);

  const newButton = (
    <Button onClick={() => void navigate(`${NEWSLETTERS_PATH}/new`)}>
      <Plus />
      {t('newsletters.new')}
    </Button>
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
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
        {newButton}
      </EmptyState>
    ) : (
      <EmptyState
        icon={Mail}
        title={t('newsletters.noDestinationTitle')}
        description={t('newsletters.noDestinationDescription')}
      >
        <Button asChild variant="outline">
          <Link to={DESTINATIONS_PATH}>{t('newsletters.goToDestinations')}</Link>
        </Button>
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
    </>
  );
}

export function Newsletters() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const navigate = useNavigate();
  const isOwner = user?.role === 'owner';
  const { data: destinations } = useDestinations(isOwner);
  const hasEmailDestination = (destinations ?? []).some((d) => d.type === 'email' && d.enabled);

  return (
    <SettingsSection
      title={t('nav.sections.newsletters')}
      description={t('nav.descriptions.newsletters')}
      actions={
        isOwner &&
        hasEmailDestination && (
          <Button onClick={() => void navigate(`${NEWSLETTERS_PATH}/new`)}>
            <Plus />
            {t('newsletters.new')}
          </Button>
        )
      }
    >
      {isOwner ? (
        <NewsletterList hasEmailDestination={hasEmailDestination} />
      ) : (
        <Alert>
          <Info />
          <AlertDescription>{t('newsletters.ownerOnly')}</AlertDescription>
        </Alert>
      )}
    </SettingsSection>
  );
}
