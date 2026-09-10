import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, Trash2 } from 'lucide-react';
import type { Newsletter } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Switch } from '@/components/ui/switch';
import { zonedDateLabel } from '@/components/settings/shared/dateLabel';
import { countsLine, outcomeVariant, scheduleSummary, type Translate } from './newsletterFormat';

interface NewsletterRowProps {
  newsletter: Newsletter;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onToggle: (enabled: boolean) => void;
  toggling: boolean;
  /** Menu items between Duplicate and Delete; the send-now flow lands here. */
  extraActions?: ReactNode;
}

export function NewsletterRow({
  newsletter,
  onEdit,
  onDuplicate,
  onDelete,
  onToggle,
  toggling,
  extraActions,
}: NewsletterRowProps) {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const { lastSend } = newsletter;
  // i18next's TFunction can't verify keys built from `${section}`/outcome at compile time.
  const translate = t as Translate;

  return (
    <Item role="listitem" variant="outline" size="sm">
      <ItemContent>
        <ItemTitle>
          {newsletter.name}
          {lastSend ? (
            <Badge variant={outcomeVariant(lastSend.outcome)}>
              {t('newsletters.lastSend', {
                outcome: t(`newsletters.outcome.${lastSend.outcome}`),
                count: lastSend.recipientCount,
              })}
            </Badge>
          ) : (
            <Badge variant="outline">{t('newsletters.neverSent')}</Badge>
          )}
        </ItemTitle>
        <ItemDescription>
          {scheduleSummary(newsletter.schedule, newsletter.timezone, translate, i18n.language)}
          {' · '}
          {newsletter.nextRunAt
            ? t('newsletters.editor.nextRun', {
                when: zonedDateLabel(newsletter.nextRunAt, newsletter.timezone, i18n.language),
                timezone: newsletter.timezone,
              })
            : t('newsletters.noNextRun')}
        </ItemDescription>
        {lastSend && (
          <ItemDescription>{countsLine(lastSend.itemCounts, translate)}</ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        <Switch
          checked={newsletter.enabled}
          onCheckedChange={onToggle}
          disabled={toggling}
          aria-label={t('newsletters.enabled')}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('newsletters.rowActions')}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>{t('common:actions.edit')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={onDuplicate}>{t('newsletters.duplicate')}</DropdownMenuItem>
            {extraActions}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 />
              {t('common:actions.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ItemActions>
    </Item>
  );
}
