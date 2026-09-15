import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDistanceToNow } from 'date-fns';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { MergeSuggestion, MergeSuggestionIdentity } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  useDismissMergeSuggestion,
  useDismissedMergeSuggestions,
  useRestoreMergeSuggestion,
} from '@/hooks/queries';
import { ServerPillList } from './ServerPillList';
import { identityDisplayName, isEmailMatchOnUsername } from './mergeSelection';

const pairKey = ([a, b]: [MergeSuggestionIdentity, MergeSuggestionIdentity]) =>
  `${a.userId}:${b.userId}`;

function IdentitySummary({ identity }: { identity: MergeSuggestionIdentity }) {
  const name = identityDisplayName(identity);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-sm font-medium" title={name}>
        {name}
      </span>
      <span className="text-muted-foreground truncate text-xs" title={`@${identity.username}`}>
        @{identity.username}
      </span>
      <ServerPillList accounts={identity.serverUsers} />
    </div>
  );
}

export function MergeSuggestionsSheet({
  open,
  onOpenChange,
  suggestions,
  onReview,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suggestions: MergeSuggestion[];
  onReview: (suggestion: MergeSuggestion) => void;
}) {
  const { t } = useTranslation(['pages']);
  const dismissed = useDismissedMergeSuggestions(open);
  const dismiss = useDismissMergeSuggestion();
  const restore = useRestoreMergeSuggestion();
  const [dismissedOpen, setDismissedOpen] = useState(false);
  const dismissedPairs = dismissed.data ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{t('pages:users.suggestionsTitle')}</SheetTitle>
          <SheetDescription>{t('pages:users.suggestionsSheetDescription')}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4">
          {suggestions.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('pages:users.suggestionsEmpty')}</p>
          ) : (
            <ul className="divide-y" aria-label={t('pages:users.suggestionsTitle')}>
              {suggestions.map((suggestion) => (
                <li key={pairKey(suggestion.users)} className="flex flex-col gap-3 py-4 first:pt-0">
                  {isEmailMatchOnUsername(suggestion) ? (
                    <p className="text-muted-foreground text-sm break-all">
                      {t('pages:users.suggestionsMatchEmailUsername', {
                        value: suggestion.matchValue,
                      })}
                    </p>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      {suggestion.matchType === 'email'
                        ? t('pages:users.suggestionsMatchEmail')
                        : t('pages:users.suggestionsMatchUsername')}
                      :{' '}
                      <span className="text-foreground font-medium break-all">
                        {suggestion.matchValue}
                      </span>
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-4">
                    <IdentitySummary identity={suggestion.users[0]} />
                    <IdentitySummary identity={suggestion.users[1]} />
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={dismiss.isPending}
                      onClick={() =>
                        dismiss.mutate([suggestion.users[0].userId, suggestion.users[1].userId])
                      }
                    >
                      {t('pages:users.suggestionsNotSame')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onReview(suggestion)}
                    >
                      {t('pages:users.suggestionsReview')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {dismissedPairs.length > 0 && (
            <Collapsible open={dismissedOpen} onOpenChange={setDismissedOpen}>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="-ml-3">
                  {dismissedOpen ? <ChevronDown /> : <ChevronRight />}
                  {t('pages:users.suggestionsDismissed', { count: dismissedPairs.length })}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="divide-y">
                  {dismissedPairs.map((pair) => {
                    const [a, b] = pair.users;
                    const label = t('pages:users.suggestionsDismissedPair', {
                      first: identityDisplayName(a),
                      second: identityDisplayName(b),
                    });
                    return (
                      <li key={pairKey(pair.users)} className="flex items-center gap-3 py-3">
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm font-medium" title={label}>
                            {label}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {t('pages:users.suggestionsDismissedAt', {
                              relative: formatDistanceToNow(new Date(pair.dismissedAt), {
                                addSuffix: true,
                              }),
                            })}
                          </span>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={restore.isPending}
                          onClick={() => restore.mutate([a.userId, b.userId])}
                        >
                          {t('pages:users.suggestionsRestore')}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
