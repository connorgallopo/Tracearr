import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, History } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { dateLabel } from '@/components/settings/shared/dateLabel';
import { useNewsletterSends } from '@/hooks/queries';
import { countsLine, outcomeVariant, type Translate } from '../newsletterFormat';
import { SendDetailSheet } from './SendDetailSheet';
import { windowLabel } from './previewSummary';

export function SendHistory({
  newsletterId,
  timezone,
}: {
  newsletterId: string;
  timezone: string;
}) {
  const { t, i18n } = useTranslation(['settings', 'common']);
  // i18next's overload set can't match the simpler Translate shape countsLine expects for its dynamically built keys.
  const translate = t as Translate;
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading, isError, error } = useNewsletterSends(newsletterId, page);

  if (isLoading) {
    return (
      <div data-testid="send-history-loading" className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error?.message ?? t('newsletters.history.loadFailed')}</AlertDescription>
      </Alert>
    );
  }
  if (data.total === 0) {
    return (
      <EmptyState
        icon={History}
        title={t('newsletters.history.empty')}
        description={t('newsletters.history.emptyDescription')}
      />
    );
  }

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <div className="flex flex-col gap-4">
      <ItemGroup className="gap-2">
        {data.sends.map((send) => (
          <Item key={send.id} role="listitem" variant="outline" size="sm">
            <ItemContent>
              <ItemTitle>
                <Badge variant={outcomeVariant(send.outcome)}>
                  {t(`newsletters.outcome.${send.outcome}`)}
                </Badge>
                {t(`newsletters.history.trigger.${send.trigger}`)}
                {' · '}
                {t('newsletters.history.window', {
                  start: windowLabel(send.windowStart, i18n.language, timezone),
                  end: windowLabel(send.windowEnd, i18n.language, timezone),
                })}
              </ItemTitle>
              <ItemDescription>
                {t('newsletters.history.recipients', { count: send.recipientCount })}
                {' · '}
                {countsLine(send.itemCounts, translate)}
                {send.finishedAt &&
                  ` · ${t('newsletters.history.finished', { when: dateLabel(send.finishedAt) })}`}
              </ItemDescription>
              {send.error && (
                <ItemDescription className="text-destructive">{send.error}</ItemDescription>
              )}
            </ItemContent>
            <ItemActions>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('newsletters.history.open', {
                  when: dateLabel(send.startedAt ?? send.windowEnd),
                })}
                onClick={() => setSelected(send.id)}
              >
                <ChevronRight />
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground text-sm">
          {t('newsletters.history.page', { page: data.page, pages })}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft />
            {t('common:actions.previous')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('common:actions.next')}
            <ChevronRight />
          </Button>
        </div>
      </div>
      <SendDetailSheet
        newsletterId={newsletterId}
        sendId={selected}
        timezone={timezone}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </div>
  );
}
