import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReleaseNotesFile, WhatsNewState } from '@tracearr/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { state, mutate } = vi.hoisted(() => ({
  state: { current: undefined as WhatsNewState | undefined },
  mutate: vi.fn(),
}));

vi.mock('@/hooks/queries', () => ({
  useWhatsNew: () => ({ data: state.current }),
  useDismissWhatsNew: () => ({ mutate }),
  useVersion: () => ({ data: undefined }),
}));

vi.mock('@/lib/releaseNotes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/releaseNotes')>();
  const notes: ReleaseNotesFile[] = [
    {
      version: '2.3.0',
      date: '2026-09-20',
      headline: 'Requests',
      changes: [{ type: 'new', text: 'requests page' }],
    },
  ];
  return { ...actual, RELEASE_NOTES: notes };
});

import { WhatsNewAutoOpen } from './WhatsNewAutoOpen';

describe('WhatsNewAutoOpen', () => {
  beforeEach(() => {
    mutate.mockReset();
  });

  it('stays closed when the running version was already seen', () => {
    state.current = { runningVersion: '2.3.0', lastSeenVersion: '2.3.0' };
    render(<WhatsNewAutoOpen />);
    expect(screen.queryByText('settings:whatsNew.title')).not.toBeInTheDocument();
  });

  it('opens for an upgraded install and dismisses on Got it', () => {
    state.current = { runningVersion: '2.3.0', lastSeenVersion: 'legacy' };
    render(<WhatsNewAutoOpen />);
    expect(screen.getByText('settings:whatsNew.title')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'settings:whatsNew.gotIt' }));
    expect(mutate).toHaveBeenCalledOnce();
    expect(screen.queryByText('settings:whatsNew.title')).not.toBeInTheDocument();
  });

  it('opens on a new beta without a "since" description', () => {
    state.current = { runningVersion: '2.3.0-beta.7', lastSeenVersion: '2.3.0-beta.6' };
    render(<WhatsNewAutoOpen />);
    expect(screen.getByText('settings:whatsNew.title')).toBeInTheDocument();
    expect(screen.getByText('settings:whatsNew.installed')).toBeInTheDocument();
    expect(screen.queryByText('settings:whatsNew.installedSince')).not.toBeInTheDocument();
  });
});
