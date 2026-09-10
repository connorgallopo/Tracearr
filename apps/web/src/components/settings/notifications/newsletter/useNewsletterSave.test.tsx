import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { defaultFormState, type NewsletterFormState } from './newsletterForm';
import { useNewsletterSave } from './useNewsletterSave';

const create = vi.fn();
const update = vi.fn();
const invalidate = vi.fn();
vi.mock('@/hooks/queries', () => ({
  useCreateNewsletter: () => ({ mutate: create, isPending: false }),
  useUpdateNewsletter: () => ({ mutate: update, isPending: false }),
  newsletterKeys: { recipients: (id: string) => ['newsletters', id, 'recipients'] },
}));
vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return { ...actual, useQueryClient: () => ({ invalidateQueries: invalidate }) };
});

const seed: NewsletterFormState = { ...defaultFormState(), name: 'Weekly', timezone: 'UTC' };

describe('useNewsletterSave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is clean on the seed and dirty on any change', () => {
    const { result, rerender } = renderHook(
      ({ state }) =>
        useNewsletterSave({ newsletterId: 'n-1', seed, state, valid: true, onSaved: vi.fn() }),
      { initialProps: { state: seed } }
    );
    expect(result.current.dirty).toBe(false);
    rerender({ state: { ...seed, name: 'Weekly 2' } });
    expect(result.current.dirty).toBe(true);
  });

  it('creates with the whole object and hands the row to onSaved', () => {
    const onSaved = vi.fn();
    const state = { ...seed, name: 'Fresh' };
    create.mockImplementation((body: unknown, opts: { onSuccess: (row: { id: string }) => void }) =>
      opts.onSuccess({ id: 'n-9' })
    );
    const { result } = renderHook(() =>
      useNewsletterSave({ newsletterId: null, seed, state, valid: true, onSaved })
    );
    act(() => result.current.save());
    expect(create).toHaveBeenCalledWith(state, expect.anything());
    expect(onSaved).toHaveBeenCalledWith({ id: 'n-9' }, state);
  });

  it('patches only the keys that differ and refreshes the recipients view', () => {
    const onSaved = vi.fn();
    const state = { ...seed, name: 'Renamed', links: { tracearr: true } };
    update.mockImplementation(
      (_vars: unknown, opts: { onSuccess: (row: { id: string }) => void }) =>
        opts.onSuccess({ id: 'n-1' })
    );
    const { result } = renderHook(() =>
      useNewsletterSave({ newsletterId: 'n-1', seed, state, valid: true, onSaved })
    );
    act(() => result.current.save());
    expect(update).toHaveBeenCalledWith(
      { id: 'n-1', data: { name: 'Renamed', links: { tracearr: true } } },
      expect.anything()
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['newsletters', 'n-1', 'recipients'] });
    expect(onSaved).toHaveBeenCalledWith({ id: 'n-1' }, state);
  });

  it('refuses to save while invalid', () => {
    const { result } = renderHook(() =>
      useNewsletterSave({
        newsletterId: null,
        seed,
        state: { ...seed, name: '' },
        valid: false,
        onSaved: vi.fn(),
      })
    );
    act(() => result.current.save());
    expect(create).not.toHaveBeenCalled();
  });
});
