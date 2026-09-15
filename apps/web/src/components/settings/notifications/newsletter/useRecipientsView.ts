import { useMemo } from 'react';
import { useNewsletterRecipients } from '@/hooks/queries';
import { recipientsDraft, type NewsletterFormState } from './newsletterForm';

/** The card, the readiness list and the page header share this one lookup. The draft keeps its identity until the scope or recipients change, which the query's debounce relies on. */
export function useRecipientsView(
  form: Pick<NewsletterFormState, 'scope' | 'recipients'>,
  newsletterId: string | null
) {
  const { scope, recipients } = form;
  const draft = useMemo(
    () => recipientsDraft(scope, recipients, newsletterId),
    [scope, recipients, newsletterId]
  );
  const query = useNewsletterRecipients(draft);
  return { query, empty: draft === null };
}
