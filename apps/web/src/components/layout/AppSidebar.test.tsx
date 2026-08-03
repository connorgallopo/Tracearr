import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './AppSidebar';

beforeAll(() => {
  window.matchMedia ||= vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

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
  useSocket: () => ({ serverConnectionStatuses: new Map() }),
}));

vi.mock('@/hooks/queries', () => ({
  useVersion: () => ({ data: undefined, isLoading: true }),
}));

function renderSidebar(initialPath = '/media') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    </MemoryRouter>
  );
}

describe('AppSidebar navigation', () => {
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

  it('opens the Stats group on the Watch Statistics overview route', () => {
    renderSidebar('/stats/overview');

    expect(screen.getByRole('link', { name: /^overview$/i })).toHaveAttribute(
      'href',
      '/stats/overview'
    );
    expect(screen.getByRole('link', { name: /activity/i })).toHaveAttribute(
      'href',
      '/stats/activity'
    );
  });
});
