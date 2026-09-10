import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Newsletter, NewsletterPreview } from '@tracearr/shared';
import { NewsletterActions } from './NewsletterActions';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { role: 'owner', email: 'owner@example.com' } }),
}));
const previewMutate = vi.fn();
const testMutate = vi.fn();
const sendMutate = vi.fn();
vi.mock('@/hooks/queries', () => ({
  usePreviewNewsletter: () => ({ mutate: previewMutate, isPending: false }),
  useTestNewsletter: () => ({ mutate: testMutate, isPending: false }),
  useSendNewsletter: () => ({ mutate: sendMutate, isPending: false }),
}));

const newsletter = { id: 'n-1', name: 'Weekly', timezone: 'UTC' } as Newsletter;
const preview: NewsletterPreview = {
  window: { start: '2026-08-28T00:00:00.000Z', end: '2026-09-04T00:00:00.000Z' },
  recipients: { resolved: 3, missingEmail: 0, suppressed: 0 },
  variants: [
    {
      key: 's-1',
      serverIds: ['s-1'],
      serverNames: ['Basement'],
      recipientCount: 3,
      subject: 'Hello there',
      html: '<p>Hi</p>',
      counts: { movies: 1, shows: 0, episodes: 0, albums: 0, mostWatched: 0 },
      trimmed: { movies: 0, shows: 0, albums: 0, mostWatched: 0 },
    },
  ],
};

describe('NewsletterActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewMutate.mockImplementation(
      (_id: string, opts: { onSuccess: (p: NewsletterPreview) => void }) => opts.onSuccess(preview)
    );
  });

  it('labels the doors as save-and-act while dirty and saves first', async () => {
    const saveThen = vi.fn((next: () => void) => next());
    render(<NewsletterActions newsletter={newsletter} dirty saveThen={saveThen} />);
    expect(
      screen.getByRole('button', { name: 'newsletters.editor.actions.saveAndPreview' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'newsletters.editor.actions.saveAndTest' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'newsletters.editor.actions.saveAndSend' })
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.actions.saveAndPreview' })
    );
    expect(saveThen).toHaveBeenCalledTimes(1);
    expect(previewMutate).toHaveBeenCalledWith('n-1', expect.anything());
  });

  it('stops when the save fails', async () => {
    const saveThen = vi.fn();
    render(<NewsletterActions newsletter={newsletter} dirty saveThen={saveThen} />);
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.actions.saveAndSend' })
    );
    expect(saveThen).toHaveBeenCalledTimes(1);
    expect(previewMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('opens the preview in a sandboxed frame with the subject and the recipients line', async () => {
    render(<NewsletterActions newsletter={newsletter} dirty={false} saveThen={(next) => next()} />);
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.actions.preview' })
    );
    const frame = await screen.findByTitle('newsletters.editor.preview.title');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame).toHaveAttribute('srcdoc', '<p>Hi</p>');
    expect(screen.getByText('Hello there')).toBeInTheDocument();
    expect(
      screen.getByText(
        'newsletters.editor.preview.recipients:{"resolved":3,"missing":0,"suppressed":0}'
      )
    ).toBeInTheDocument();
  });

  it('prefills the test address with the owner email and queues the test', async () => {
    render(<NewsletterActions newsletter={newsletter} dirty={false} saveThen={(next) => next()} />);
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.actions.test' }));
    const input = screen.getByLabelText('newsletters.editor.test.address');
    expect(input).toHaveValue('owner@example.com');
    await userEvent.clear(input);
    await userEvent.type(input, 'me@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.test.send' }));
    expect(testMutate).toHaveBeenCalledWith(
      { id: 'n-1', address: 'me@example.com' },
      expect.anything()
    );
  });

  it('resets the test address on reopen instead of keeping an edited-then-cancelled value', async () => {
    render(<NewsletterActions newsletter={newsletter} dirty={false} saveThen={(next) => next()} />);
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.actions.test' }));
    const input = screen.getByLabelText('newsletters.editor.test.address');
    await userEvent.clear(input);
    await userEvent.type(input, 'someone-else@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.actions.test' }));
    expect(screen.getByLabelText('newsletters.editor.test.address')).toHaveValue(
      'owner@example.com'
    );
  });

  it('opens the send-now confirmation', async () => {
    render(<NewsletterActions newsletter={newsletter} dirty={false} saveThen={(next) => next()} />);
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.actions.send' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'newsletters.editor.send.title:{"name":"Weekly"}'
    );
  });
});
