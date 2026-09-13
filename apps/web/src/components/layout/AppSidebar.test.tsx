import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidebarProvider } from '@/components/ui/sidebar';
import { ThemeProvider } from '@/components/theme-provider';
import { AppSidebar } from './AppSidebar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: () => ({
    servers: [],
    selectedServerIds: [],
    isAllServersSelected: true,
    toggleServer: vi.fn(),
    selectAllServers: vi.fn(),
    deselectAllExcept: vi.fn(),
    isLoading: false,
    isFetching: false,
  }),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ serverConnectionStatuses: new Map(), isConnected: false }),
}));

const { seerr } = vi.hoisted(() => ({ seerr: { configured: false } }));

vi.mock('@/hooks/queries', () => ({
  useVersion: () => ({ data: undefined, isLoading: true }),
  useRequestsConfigured: () => ({ data: seerr }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { username: 'tester', email: 'tester@example.test', thumbUrl: null },
    logout: vi.fn(),
  }),
}));

function renderSidebar(initialPath = '/media') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <SidebarProvider>
            <AppSidebar />
          </SidebarProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

describe('AppSidebar navigation', () => {
  beforeEach(() => {
    seerr.configured = false;
  });

  it('hides the Requests entry until a Seerr is linked', () => {
    renderSidebar();

    expect(screen.queryByText('requests')).not.toBeInTheDocument();
  });

  it('shows the Requests entry once a Seerr is linked', () => {
    seerr.configured = true;
    renderSidebar();

    expect(screen.getByText('requests')).toBeInTheDocument();
  });

  it('renders the Media group with Overview/Browse/Genres and the moved library entries', () => {
    renderSidebar();

    expect(screen.getByText('media')).toBeInTheDocument();
    expect(screen.getByText('overview')).toBeInTheDocument();
    expect(screen.getByText('mediaBrowse')).toBeInTheDocument();
    expect(screen.getByText('mediaGenres')).toBeInTheDocument();
    expect(screen.getByText('quality')).toBeInTheDocument();
    expect(screen.getByText('storage')).toBeInTheDocument();
    expect(screen.getByText('watch')).toBeInTheDocument();
  });

  it('does not render a separate top-level Library group', () => {
    renderSidebar();

    expect(screen.queryByText('library')).not.toBeInTheDocument();
  });

  it('links the moved library entries to their unchanged paths', () => {
    renderSidebar();

    expect(screen.getByRole('link', { name: /quality/i })).toHaveAttribute(
      'href',
      '/library/quality'
    );
    expect(screen.getByRole('link', { name: /storage/i })).toHaveAttribute(
      'href',
      '/library/storage'
    );
    expect(screen.getByRole('link', { name: /watch/i })).toHaveAttribute('href', '/library/watch');
  });

  it('links the new media entries to their static paths', () => {
    renderSidebar();

    expect(screen.getByRole('link', { name: /^overview$/i })).toHaveAttribute('href', '/media');
    expect(screen.getByRole('link', { name: /mediaBrowse/i })).toHaveAttribute(
      'href',
      '/media/browse'
    );
    expect(screen.getByRole('link', { name: /mediaGenres/i })).toHaveAttribute(
      'href',
      '/media/genres'
    );
  });
});
