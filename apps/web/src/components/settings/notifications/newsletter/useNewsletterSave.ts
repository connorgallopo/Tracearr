import type { Newsletter } from '@tracearr/shared';
import { useCreateNewsletter, useUpdateNewsletter } from '@/hooks/queries';
import { deepEqual, diffPatch, type NewsletterFormState } from './newsletterForm';

interface UseNewsletterSaveArgs {
  newsletterId: string | null;
  seed: NewsletterFormState;
  state: NewsletterFormState;
  valid: boolean;
  onSaved: (row: Newsletter, saved: NewsletterFormState) => void;
}

/** Create posts the whole object; edit patches the keys that moved. Nothing else on the page saves. */
export function useNewsletterSave({
  newsletterId,
  seed,
  state,
  valid,
  onSaved,
}: UseNewsletterSaveArgs) {
  const create = useCreateNewsletter();
  const update = useUpdateNewsletter();
  const dirty = !deepEqual(seed, state);
  const pending = create.isPending || update.isPending;

  const save = () => {
    if (!valid || pending) return;
    const saved = state;
    if (newsletterId === null) {
      create.mutate(saved, { onSuccess: (row) => onSaved(row, saved) });
      return;
    }
    update.mutate(
      { id: newsletterId, data: diffPatch(seed, saved) },
      { onSuccess: (row) => onSaved(row, saved) }
    );
  };

  return { dirty, pending, save };
}
