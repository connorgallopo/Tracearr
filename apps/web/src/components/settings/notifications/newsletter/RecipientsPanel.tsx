import { useState } from 'react';
import { Users, UserX } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldDescription } from '@/components/ui/field';
import { ItemGroup } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import type { NewsletterFormState } from './newsletterForm';
import { EntryRow, useTranslate, type EntryActions } from './RecipientRows';
import { RecipientsSheet } from './RecipientsSheet';
import { entryUserId, partitionRecipients, pendingChange, summaryEntries } from './recipientsView';
import { useRecipientsView } from './useRecipientsView';

export function RecipientsPanel({
  form,
  newsletterId,
  savedExcludeUserIds,
  servers,
  onExclude,
  onInclude,
}: {
  form: Pick<NewsletterFormState, 'scope' | 'recipients'>;
  newsletterId: string | null;
  /** The saved row's exclusions; the view answers for the form, so the difference is what Save would change. */
  savedExcludeUserIds: readonly string[];
  servers: { id: string; name: string }[];
  onExclude: (userIds: string[]) => void;
  onInclude: (userIds: string[]) => void;
}) {
  const { t } = useTranslate();
  const { query, empty } = useRecipientsView(form, newsletterId);
  const { data, isError, error, refetch } = query;
  const [manageOpen, setManageOpen] = useState(false);

  const noRecipients = (
    <EmptyState
      icon={UserX}
      title={t('newsletters.editor.recipients.emptyTitle')}
      description={t('newsletters.editor.recipients.emptyDescription')}
    />
  );

  if (empty) return noRecipients;
  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {error?.message ?? t('newsletters.editor.recipients.loadFailed')}
        </AlertDescription>
      </Alert>
    );
  }
  // A draft that has not settled yet leaves the query idle with no data, which is still loading to the owner.
  if (!data) return <Skeleton className="h-24 w-full" />;

  const total = data.recipients.length + data.missing.length + data.excluded.length;
  if (total === 0) return noRecipients;

  const partition = partitionRecipients(data);
  const pending = (userId: string | null) =>
    pendingChange(userId, form.recipients.excludeUserIds, savedExcludeUserIds);
  const actions: EntryActions = { onExclude, onInclude, onContactSaved: () => void refetch() };
  const joined = data.recipients.filter((r) => r.newSinceLastSend).length;
  const part = (key: string, count: number) => (count > 0 ? [t(key, { count })] : []);
  const counts = [
    t('newsletters.editor.recipients.willReceive', { count: partition.receive.length }),
    ...part('newsletters.editor.recipients.excludedCount', partition.excluded.length),
    ...part('newsletters.editor.recipients.notIncludable', partition.notIncludable.length),
    ...part('newsletters.editor.recipients.noAddress', partition.missing.length),
    ...part('newsletters.editor.recipients.suppressedCount', partition.suppressed.length),
  ];

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium">{counts.join(' · ')}</p>
        {joined > 0 && (
          <FieldDescription>
            {t('newsletters.editor.recipients.joinedSinceLastSend', { count: joined })}
          </FieldDescription>
        )}
      </div>
      <ItemGroup className="gap-1">
        {summaryEntries(partition, pending).map((entry) => (
          <EntryRow
            key={entry.key}
            entry={entry}
            pending={pending(entryUserId(entry))}
            actions={actions}
          />
        ))}
      </ItemGroup>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => setManageOpen(true)}>
          <Users />
          {t('newsletters.editor.recipients.manage', { count: total })}
        </Button>
      </div>
      <RecipientsSheet
        open={manageOpen}
        onOpenChange={setManageOpen}
        partition={partition}
        servers={servers}
        pending={pending}
        actions={actions}
      />
    </div>
  );
}
