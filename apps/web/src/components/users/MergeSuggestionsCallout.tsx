import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users as UsersIcon } from 'lucide-react';
import type { MergeSuggestion } from '@tracearr/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useMergeSuggestions } from '@/hooks/queries';
import { MergeSuggestionsSheet } from './MergeSuggestionsSheet';
import { identityDisplayName, isEmailMatchOnUsername } from './mergeSelection';

const HEADING_ID = 'merge-suggestions-heading';

const PAIR_SUMMARY_KEYS = {
  email: {
    single: 'pages:users.suggestionsPairEmail',
    more: 'pages:users.suggestionsPairEmailMore',
  },
  emailUsername: {
    single: 'pages:users.suggestionsPairEmailUsername',
    more: 'pages:users.suggestionsPairEmailUsernameMore',
  },
  username: {
    single: 'pages:users.suggestionsPairUsername',
    more: 'pages:users.suggestionsPairUsernameMore',
  },
} as const;

export function MergeSuggestionsCallout({
  onReview,
}: {
  onReview: (suggestion: MergeSuggestion) => void;
}) {
  const { t } = useTranslation(['pages']);
  const { data, isError } = useMergeSuggestions(true);
  const [sheetOpen, setSheetOpen] = useState(false);

  if (isError) {
    return <p className="text-muted-foreground text-sm">{t('pages:users.suggestionsError')}</p>;
  }

  const suggestions = data ?? [];
  const first = suggestions[0];
  const remaining = suggestions.length - 1;

  return (
    <>
      {first && (
        <section aria-labelledby={HEADING_ID}>
          {/* A standing callout; Alert's default role="alert" would announce it on every visit. */}
          <Alert role="note" className="has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr_auto]">
            <UsersIcon />
            <AlertTitle id={HEADING_ID}>
              {t('pages:users.suggestionsCount', { count: suggestions.length })}
            </AlertTitle>
            <AlertDescription>
              {t(
                PAIR_SUMMARY_KEYS[
                  isEmailMatchOnUsername(first) ? 'emailUsername' : first.matchType
                ][remaining > 0 ? 'more' : 'single'],
                {
                  first: identityDisplayName(first.users[0]),
                  second: identityDisplayName(first.users[1]),
                  count: remaining,
                }
              )}
            </AlertDescription>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="col-start-3 row-span-2 row-start-1 self-center"
              onClick={() => setSheetOpen(true)}
            >
              {t('pages:users.suggestionsReview')}
            </Button>
          </Alert>
        </section>
      )}
      <MergeSuggestionsSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        suggestions={suggestions}
        onReview={onReview}
      />
    </>
  );
}
