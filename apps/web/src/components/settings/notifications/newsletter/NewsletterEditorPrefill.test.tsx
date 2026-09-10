import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Destination } from '@tracearr/shared';
import { NewsletterEditor } from './NewsletterEditor';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }));
vi.mock('@/hooks/queries', () => ({
  useNewsletter: vi.fn(),
  useServers: () => ({ data: [] }),
  useLibraries: () => ({ data: { data: [] }, isLoading: false }),
  useCreateNewsletter: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNewsletter: () => ({ mutate: vi.fn(), isPending: false }),
  useDestinations: vi.fn(),
  useSettings: vi.fn(),
  useNewsletterRecipients: vi.fn(),
  useNewsletterSends: vi.fn(),
  useNewsletterVariants: () => ({ data: undefined }),
  useUpdateUserIdentity: () => ({ mutate: vi.fn(), isPending: false }),
  usePreviewNewsletter: () => ({ mutate: vi.fn(), isPending: false }),
  usePreviewDraftNewsletter: () => ({ mutate: vi.fn(), isPending: false }),
  useTestNewsletter: () => ({ mutate: vi.fn(), isPending: false }),
  useSendNewsletter: () => ({ mutate: vi.fn(), isPending: false }),
  newsletterKeys: { recipients: (id: string) => ['newsletters', id, 'recipients'] },
}));
vi.mock('@/components/ui/rich-text-field', () => ({
  RichTextField: ({ id }: { id: string }) => <div data-testid={`rich-${id}`} />,
}));

import { useAuth } from '@/hooks/useAuth';
import {
  useDestinations,
  useNewsletter,
  useNewsletterRecipients,
  useSettings,
} from '@/hooks/queries';

const postmark = { id: 'd-1', name: 'Postmark', type: 'email', enabled: true } as Destination;

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({
    user: { role: 'owner', email: 'me@example.com' },
  } as unknown as ReturnType<typeof useAuth>);
  vi.mocked(useNewsletter).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useNewsletter>);
  vi.mocked(useDestinations).mockReturnValue({ data: [postmark] } as unknown as ReturnType<
    typeof useDestinations
  >);
  vi.mocked(useSettings).mockReturnValue({ data: {} } as unknown as ReturnType<typeof useSettings>);
  vi.mocked(useNewsletterRecipients).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useNewsletterRecipients>);
});

function renderNew(state: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/settings/notifications/newsletters/new', element: <NewsletterEditor /> }],
    { initialEntries: [{ pathname: '/settings/notifications/newsletters/new', state }] }
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

describe('NewsletterEditor prefill', () => {
  it('seeds the destination from router state and starts clean', () => {
    renderNew({ destinationId: 'd-1' });

    expect(
      screen.getByRole('combobox', { name: 'newsletters.editor.delivery.destination' })
    ).toHaveTextContent('Postmark');
    expect(screen.queryByText('newsletters.editor.unsaved')).not.toBeInTheDocument();
  });

  it('starts with no destination when the state carries none', () => {
    renderNew(null);

    expect(
      screen.getByRole('combobox', { name: 'newsletters.editor.delivery.destination' })
    ).toHaveTextContent('newsletters.editor.delivery.pickDestination');
  });
});
