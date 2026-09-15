import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditUserIdentityDialog } from './EditUserIdentityDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));
const mutate = vi.fn();
vi.mock('@/hooks/queries', () => ({
  useUpdateUserIdentity: () => ({ mutate, isPending: false }),
}));

function renderDialog(over: Partial<React.ComponentProps<typeof EditUserIdentityDialog>> = {}) {
  const onOpenChange = vi.fn();
  render(
    <EditUserIdentityDialog
      open
      onOpenChange={onOpenChange}
      userId="su-1"
      currentName="Ann"
      currentContactEmail={null}
      username="ann"
      {...over}
    />
  );
  return onOpenChange;
}

describe('EditUserIdentityDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends only the fields that changed', async () => {
    mutate.mockImplementation((_vars: unknown, opts: { onSuccess: () => void }) =>
      opts.onSuccess()
    );
    const onOpenChange = renderDialog();
    await userEvent.type(screen.getByLabelText('userDetail.contactEmail'), 'ann@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.save' }));
    expect(mutate).toHaveBeenCalledWith(
      { id: 'su-1', data: { contactEmail: 'ann@example.com' } },
      expect.anything()
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('clears a name to null and a contact email to null', async () => {
    renderDialog({ currentContactEmail: 'ann@example.com' });
    await userEvent.clear(screen.getByLabelText('userDetail.displayName'));
    await userEvent.clear(screen.getByLabelText('userDetail.contactEmail'));
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.save' }));
    expect(mutate).toHaveBeenCalledWith(
      { id: 'su-1', data: { name: null, contactEmail: null } },
      expect.anything()
    );
  });

  it('refuses a malformed address and closes without a patch when nothing changed', async () => {
    const onOpenChange = renderDialog();
    await userEvent.type(screen.getByLabelText('userDetail.contactEmail'), 'nope');
    expect(screen.getByRole('button', { name: 'common:actions.save' })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('userDetail.contactEmail'));
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.save' }));
    expect(mutate).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByText('userDetail.contactEmailHelp')).toBeInTheDocument();
  });
});
