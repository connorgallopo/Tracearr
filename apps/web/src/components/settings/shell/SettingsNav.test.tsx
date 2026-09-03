import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { SettingsNav } from './SettingsNav';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? Object.values(options).join(' / ') : key,
  }),
}));

function CurrentPath() {
  const { pathname } = useLocation();
  return <span data-testid="pathname">{pathname}</span>;
}

function renderNav(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SettingsNav />
      <Routes>
        <Route path="/settings/*" element={<CurrentPath />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('SettingsNav', () => {
  it('renders one link per visible section, grouped', () => {
    renderNav('/settings/general/appearance');

    const nav = screen.getByRole('navigation', { name: 'nav.label' });
    expect(nav).toHaveClass('hidden', '@3xl/settings:block', 'w-52');
    expect(screen.getByText('nav.groups.data')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'nav.sections.backup' })).toHaveAttribute(
      'href',
      '/settings/data/backup'
    );
  });

  it('marks the section matching the pathname active', () => {
    renderNav('/settings/access/remote');

    expect(screen.getByRole('link', { name: 'nav.sections.remote' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByRole('link', { name: 'nav.sections.guest' })).not.toHaveAttribute(
      'aria-current'
    );
  });

  it('leaves the two hidden sections out of both the column and the select', async () => {
    renderNav('/settings/notifications/destinations');

    expect(
      screen.queryByRole('link', { name: 'nav.sections.newsletters' })
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('combobox'));
    expect(
      screen.queryByRole('option', { name: /nav.sections.newsletters/ })
    ).not.toBeInTheDocument();
  });

  it('offers every section in the select as "Group / Section"', async () => {
    renderNav('/settings/general/appearance');

    const wrapper = screen.getByTestId('settings-nav-select');
    expect(wrapper).toHaveClass('@3xl/settings:hidden');

    await userEvent.click(screen.getByRole('combobox'));
    expect(
      screen.getByRole('option', { name: 'nav.groups.servers / nav.sections.connections' })
    ).toBeInTheDocument();
  });

  it('navigates when the select changes', async () => {
    renderNav('/settings/general/appearance');

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(
      screen.getByRole('option', { name: 'nav.groups.data / nav.sections.import' })
    );

    expect(screen.getByTestId('pathname')).toHaveTextContent('/settings/data/import');
  });
});
