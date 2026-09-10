import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Newsletter, NewsletterPreview } from '@tracearr/shared';
import { defaultFormState, type NewsletterFormState } from './newsletterForm';
import { NewsletterActions, type NewsletterActionsHandle } from './NewsletterActions';

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
const previewDraftMutate = vi.fn();
const testMutate = vi.fn();
const sendMutate = vi.fn();
vi.mock('@/hooks/queries', () => ({
  usePreviewNewsletter: () => ({ mutate: previewMutate, isPending: false }),
  usePreviewDraftNewsletter: () => ({ mutate: previewDraftMutate, isPending: false }),
  useTestNewsletter: () => ({ mutate: testMutate, isPending: false }),
  useSendNewsletter: () => ({ mutate: sendMutate, isPending: false }),
  useNewsletterVariants: vi.fn(),
}));

import { useNewsletterVariants } from '@/hooks/queries';

const newsletter = { id: 'n-1', name: 'Weekly', timezone: 'UTC' } as Newsletter;
const state: NewsletterFormState = { ...defaultFormState(), name: 'Weekly', timezone: 'UTC' };
const refuse = vi.fn();
const preview: NewsletterPreview = {
  window: {
    start: '2026-08-28T00:00:00.000Z',
    end: '2026-09-04T00:00:00.000Z',
    fromWatermark: false,
  },
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

const emptyUnion: NewsletterPreview = {
  ...preview,
  variants: [
    {
      ...preview.variants[0],
      key: 's-1,s-2',
      serverNames: ['Attic', 'Basement'],
      recipientCount: 0,
      subject: 'Both',
      html: '<p>Both</p>',
    },
    { ...preview.variants[0], key: 's-1', serverNames: ['Basement'], recipientCount: 1 },
    {
      ...preview.variants[0],
      key: 's-2',
      serverNames: ['Attic'],
      recipientCount: 4,
      subject: 'Attic only',
      html: '<p>Attic</p>',
      counts: { movies: 14, shows: 0, episodes: 0, albums: 0, mostWatched: 0 },
      trimmed: { movies: 2, shows: 0, albums: 0, mostWatched: 0 },
    },
  ],
};

function renderActions(over: Partial<Parameters<typeof NewsletterActions>[0]> = {}) {
  return render(
    <NewsletterActions
      newsletter={newsletter}
      state={state}
      dirty={false}
      valid
      onRefuse={refuse}
      {...over}
    />
  );
}

describe('NewsletterActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewMutate.mockImplementation(
      (_id: string, opts: { onSuccess: (p: NewsletterPreview) => void }) => opts.onSuccess(preview)
    );
    previewDraftMutate.mockImplementation(
      (_body: unknown, opts: { onSuccess: (p: NewsletterPreview) => void }) =>
        opts.onSuccess(preview)
    );
    vi.mocked(useNewsletterVariants).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useNewsletterVariants>);
  });

  it('previews the saved row when the form is clean', async () => {
    renderActions();
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.actions.preview' })
    );
    expect(previewMutate).toHaveBeenCalledWith('n-1', expect.anything());
    expect(previewDraftMutate).not.toHaveBeenCalled();
    const frame = await screen.findByTitle('newsletters.editor.preview.title');
    expect(frame).toHaveAttribute('srcdoc', '<p>Hi</p>');
    expect(screen.getByText('Hello there')).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.preview.linksNote')).toBeInTheDocument();
    expect(screen.queryByText('newsletters.editor.preview.draft')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'newsletters.editor.preview.recipients:{"resolved":3,"missing":0,"suppressed":0}'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText('newsletters.editor.preview.window:{"start":"Aug 28","end":"Sep 4"}')
    ).toBeInTheDocument();
  });

  it('previews the draft with the row id when the form is dirty, without saving', async () => {
    renderActions({ dirty: true });
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.actions.preview' })
    );
    expect(previewDraftMutate).toHaveBeenCalledWith(
      { newsletterId: 'n-1', newsletter: state },
      expect.anything()
    );
    expect(previewMutate).not.toHaveBeenCalled();
    expect(await screen.findByText('newsletters.editor.preview.draft')).toBeInTheDocument();
  });

  it('previews a new newsletter from the form alone and offers no send buttons', async () => {
    renderActions({ newsletter: null });
    expect(
      screen.queryByRole('button', { name: 'newsletters.editor.actions.test' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'newsletters.editor.actions.more' })
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.actions.preview' })
    );
    expect(previewDraftMutate).toHaveBeenCalledWith({ newsletter: state }, expect.anything());
  });

  it('disables Preview while the form is invalid and says why', async () => {
    renderActions({ valid: false, dirty: true });
    const button = screen.getByRole('button', { name: 'newsletters.editor.actions.preview' });
    expect(button).toBeDisabled();
    await userEvent.hover(button.parentElement as HTMLElement);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('newsletters.editor.fixFirst');
  });

  it('hands an invalid form back to the page instead of previewing it', async () => {
    const ref = createRef<NewsletterActionsHandle>();
    renderActions({ valid: false, ref });
    ref.current?.openPreview();
    expect(previewMutate).not.toHaveBeenCalled();
    expect(previewDraftMutate).not.toHaveBeenCalled();
    expect(screen.queryByTitle('newsletters.editor.preview.title')).not.toBeInTheDocument();
    expect(refuse).toHaveBeenCalled();
  });

  it('disables Send test and Send now while dirty, with the save-first reason, and sends nothing', async () => {
    renderActions({ dirty: true });
    const test = screen.getByRole('button', { name: 'newsletters.editor.actions.test' });
    expect(test).toBeDisabled();
    await userEvent.hover(test.parentElement as HTMLElement);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'newsletters.editor.sendNeedsSave'
    );
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.actions.more' }));
    const send = await screen.findByRole('menuitem', {
      name: /newsletters\.editor\.actions\.send/,
    });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).toHaveTextContent('newsletters.editor.sendNeedsSave');
    expect(testMutate).not.toHaveBeenCalled();
    expect(sendMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('names what a test and a real send cost, and opens the send confirmation from the menu', async () => {
    renderActions();
    const test = screen.getByRole('button', { name: 'newsletters.editor.actions.test' });
    await userEvent.hover(test.parentElement as HTMLElement);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'newsletters.editor.actions.testHint'
    );
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.actions.more' }));
    const send = await screen.findByRole('menuitem', {
      name: /newsletters\.editor\.actions\.send/,
    });
    expect(send).toHaveTextContent('newsletters.editor.actions.sendHint');
    await userEvent.click(send);
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'newsletters.editor.send.title:{"name":"Weekly"}'
    );
  });

  it('prefills the test address with the owner email and queues the test', async () => {
    renderActions();
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

  it('opens on the version most people receive, hides a union nobody gets, and labels the tabs as people', async () => {
    previewMutate.mockImplementation(
      (_id: string, opts: { onSuccess: (p: NewsletterPreview) => void }) =>
        opts.onSuccess(emptyUnion)
    );
    renderActions();
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.actions.preview' })
    );
    const frame = await screen.findByTitle('newsletters.editor.preview.title');
    expect(frame).toHaveAttribute('srcdoc', '<p>Attic</p>');
    expect(screen.getByText('Attic only')).toBeInTheDocument();
    expect(
      screen
        .getAllByLabelText(/newsletters\.editor\.previewVariant/)
        .map((r) => r.getAttribute('aria-label'))
    ).toEqual([
      'newsletters.editor.previewVariant:{"count":1,"servers":"Basement"}',
      'newsletters.editor.previewVariant:{"count":4,"servers":"Attic"}',
    ]);
    expect(
      screen.getByText('newsletters.editor.preview.variantTab:{"count":4,"servers":"Attic"}')
    ).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.send.trimmed:{"count":2}')).toBeInTheDocument();
    expect(
      screen.getByText(
        'newsletters.editor.preview.countsListed.movies:{"listed":10,"found":14}, newsletters.editor.preview.countsListed.shows:{"listed":0,"found":0}, newsletters.editor.preview.countsListed.albums:{"listed":0,"found":0}'
      )
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('radio', {
        name: 'newsletters.editor.previewVariant:{"count":1,"servers":"Basement"}',
      })
    );
    expect(screen.getByTitle('newsletters.editor.preview.title')).toHaveAttribute(
      'srcdoc',
      '<p>Hi</p>'
    );
  });

  it('renders no switcher for a single variant and says the window began at the last email when it did', async () => {
    previewMutate.mockImplementation(
      (_id: string, opts: { onSuccess: (p: NewsletterPreview) => void }) =>
        opts.onSuccess({ ...preview, window: { ...preview.window, fromWatermark: true } })
    );
    renderActions();
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.actions.preview' })
    );
    await screen.findByTitle('newsletters.editor.preview.title');
    // Radix renders a single-select ToggleGroup's items with role radio; the width and images toggles are the only radios then.
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(
      screen.getByText('newsletters.editor.preview.windowSince:{"start":"Aug 28","end":"Sep 4"}')
    ).toBeInTheDocument();
  });

  it('the test dialog keeps the union among its versions and sends the picked key, none for the union', async () => {
    vi.mocked(useNewsletterVariants).mockReturnValue({
      data: {
        window: { start: '2026-08-28T00:00:00.000Z', end: '2026-09-04T00:00:00.000Z' },
        variants: [
          {
            key: 's-1,s-2',
            serverIds: ['s-1', 's-2'],
            serverNames: ['Attic', 'Basement'],
            recipientCount: 0,
            counts: {},
            isEmpty: false,
          },
          {
            key: 's-2',
            serverIds: ['s-2'],
            serverNames: ['Attic'],
            recipientCount: 4,
            counts: {},
            isEmpty: false,
          },
        ],
      },
    } as unknown as ReturnType<typeof useNewsletterVariants>);
    renderActions();
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.actions.test' }));
    expect(
      screen.getByRole('radio', {
        name: 'newsletters.editor.previewVariant:{"count":0,"servers":"Attic and Basement"}',
      })
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.test.send' }));
    expect(testMutate).toHaveBeenLastCalledWith(
      { id: 'n-1', address: 'owner@example.com' },
      expect.anything()
    );
    await userEvent.click(
      screen.getByRole('radio', {
        name: 'newsletters.editor.previewVariant:{"count":4,"servers":"Attic"}',
      })
    );
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.test.send' }));
    expect(testMutate).toHaveBeenLastCalledWith(
      { id: 'n-1', address: 'owner@example.com', variantKey: 's-2' },
      expect.anything()
    );
  });
});
