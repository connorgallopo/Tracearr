import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NewsletterRecipientStatus, NewsletterSendHtml } from '@tracearr/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { HtmlPreviewDialog } from '@/components/settings/shared/HtmlPreviewDialog';
import { dateLabel } from '@/components/settings/shared/dateLabel';
import { useNewsletterSend, useNewsletterSendHtml, useRetryFailedSend } from '@/hooks/queries';
import { outcomeVariant, type OutcomeVariant } from '../newsletterFormat';
import { windowLabel } from './previewSummary';

export function recipientVariant(status: NewsletterRecipientStatus): OutcomeVariant {
  switch (status) {
    case 'sent':
      return 'success';
    case 'failed':
      return 'danger';
    case 'suppressed':
      return 'warning';
    case 'unknown':
      return 'outline';
    case 'queued':
      return 'secondary';
  }
}

export function SendDetailSheet({
  newsletterId,
  sendId,
  timezone,
  onOpenChange,
}: {
  newsletterId: string;
  sendId: string | null;
  timezone: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const { data, isLoading, isError, error } = useNewsletterSend(newsletterId, sendId);
  const html = useNewsletterSendHtml();
  const retry = useRetryFailedSend();
  const [snapshot, setSnapshot] = useState<NewsletterSendHtml | null>(null);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const canRetry = data?.outcome === 'partial' || data?.outcome === 'failed';

  return (
    <Sheet open={sendId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="flex flex-col overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t('newsletters.history.sendTitle')}</SheetTitle>
          {data && (
            <SheetDescription>
              {t(`newsletters.history.trigger.${data.trigger}`)}
              {' · '}
              {t('newsletters.history.window', {
                start: windowLabel(data.windowStart, i18n.language, timezone),
                end: windowLabel(data.windowEnd, i18n.language, timezone),
              })}
            </SheetDescription>
          )}
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4">
          {isLoading && <Skeleton className="h-40 w-full" />}
          {isError && (
            <Alert variant="destructive">
              <AlertDescription>{error?.message}</AlertDescription>
            </Alert>
          )}
          {data && (
            <>
              <div className="flex items-center gap-2">
                <Badge variant={outcomeVariant(data.outcome)}>
                  {t(`newsletters.outcome.${data.outcome}`)}
                </Badge>
                {data.finishedAt && (
                  <span className="text-muted-foreground text-sm">
                    {t('newsletters.history.finished', { when: dateLabel(data.finishedAt) })}
                  </span>
                )}
              </div>
              {data.error && (
                <Alert variant="destructive">
                  <AlertDescription>{data.error}</AlertDescription>
                </Alert>
              )}
              <ItemGroup className="gap-1">
                {data.recipients.map((recipient) => (
                  <Item key={recipient.id} role="listitem" variant="outline" size="sm">
                    <ItemContent>
                      <ItemTitle>
                        {recipient.address}
                        <Badge variant={recipientVariant(recipient.status)}>
                          {t(`newsletters.history.status.${recipient.status}`)}
                        </Badge>
                      </ItemTitle>
                      <ItemDescription>
                        {t('newsletters.history.attempts', { count: recipient.attempts })}
                        {recipient.sentAt && ` · ${dateLabel(recipient.sentAt)}`}
                        {recipient.status === 'unknown' &&
                          ` · ${t('newsletters.history.unknownHelp')}`}
                      </ItemDescription>
                      {recipient.error && (
                        <ItemDescription className="text-destructive">
                          {recipient.error}
                        </ItemDescription>
                      )}
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            </>
          )}
        </div>
        <SheetFooter>
          {data && !data.hasSnapshot && (
            <span className="text-muted-foreground text-sm">{t('newsletters.history.pruned')}</span>
          )}
          <Button
            variant="outline"
            disabled={!data?.hasSnapshot || html.isPending}
            onClick={() =>
              sendId &&
              html.mutate(
                { id: newsletterId, sendId },
                {
                  onSuccess: (body) => {
                    setSnapshot(body);
                    setSnapshotOpen(true);
                  },
                }
              )
            }
          >
            {t('newsletters.history.openSnapshot')}
          </Button>
          {canRetry && (
            <Button
              disabled={retry.isPending || !data?.hasSnapshot}
              onClick={() => sendId && retry.mutate({ id: newsletterId, sendId })}
            >
              {t('newsletters.history.retryFailed')}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
      <HtmlPreviewDialog
        open={snapshotOpen}
        onOpenChange={setSnapshotOpen}
        title={t('newsletters.history.snapshotTitle')}
        subject={snapshot?.subject}
        html={snapshot?.html ?? null}
        modal={false}
      />
    </Sheet>
  );
}
