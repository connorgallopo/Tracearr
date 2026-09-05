import { useQueryClient } from '@tanstack/react-query';
import type { Newsletter } from '@tracearr/shared';
import { newsletterKeys, useCreateNewsletter, useUpdateNewsletter } from '@/hooks/queries';
import { deepEqual, diffPatch, type NewsletterFormState } from './newsletterForm';

export type SaveThen = (next: () => void) => void;

interface UseNewsletterSaveArgs {
  newsletterId: string | null;
  seed: NewsletterFormState;
  state: NewsletterFormState;
  valid: boolean;
  onSaved: (row: Newsletter, saved: NewsletterFormState) => void;
}

/** Create posts the whole object; edit patches the keys that moved. A header action on a dirty form saves first and only then acts. */
export function useNewsletterSave({
  newsletterId,
  seed,
  state,
  valid,
  onSaved,
}: UseNewsletterSaveArgs) {
  const queryClient = useQueryClient();
  const create = useCreateNewsletter();
  const update = useUpdateNewsletter();
  const dirty = !deepEqual(seed, state);
  const pending = create.isPending || update.isPending;

  const save = (after?: () => void) => {
    if (!valid || pending) return;
    const saved = state;
    if (newsletterId === null) {
      create.mutate(saved, {
        onSuccess: (row) => {
          onSaved(row, saved);
          after?.();
        },
        // A failed save must not run the queued action; the hook's own onError already toasts it.
        onError: () => {},
      });
      return;
    }
    update.mutate(
      { id: newsletterId, data: diffPatch(seed, saved) },
      {
        onSuccess: (row) => {
          void queryClient.invalidateQueries({ queryKey: newsletterKeys.recipients(newsletterId) });
          onSaved(row, saved);
          after?.();
        },
        onError: () => {},
      }
    );
  };

  const saveThen: SaveThen = (next) => {
    if (!dirty) {
      next();
      return;
    }
    save(next);
  };

  return { dirty, pending, save: () => save(), saveThen };
}
