import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReleaseNotesFile } from '@tracearr/shared';
import { WhatsNewDialog } from './WhatsNewDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

const minor: ReleaseNotesFile = {
  version: '2.2.0',
  date: '2026-08-27',
  headline: 'Automations, templates, share codes, and new maps',
  highlights: [{ title: 'Automations', body: 'Rules are automations now.' }],
  changes: [
    { type: 'fix', text: 'maps run fully local', refs: ['#1091'] },
    { type: 'new', text: 'use `tracearr1.` codes' },
  ],
};
const patch: ReleaseNotesFile = {
  version: '2.2.3',
  date: '2026-08-30',
  changes: [{ type: 'fix', text: 'merged users stay merged' }],
};

function renderDialog(onOpenChange = vi.fn()) {
  render(
    <WhatsNewDialog
      open
      onOpenChange={onOpenChange}
      mode="auto"
      sections={{ lead: [minor], patches: [patch], since: '2.2.0', earlier: [] }}
      runningVersion="2.2.3"
      sinceVersion="2.1.0"
      latestVersion="v2.2.3"
    />
  );
  return onOpenChange;
}

describe('WhatsNewDialog', () => {
  it('expands the lead release and collapses patches under their label', () => {
    renderDialog();
    expect(
      screen.getByText('Automations, templates, share codes, and new maps')
    ).toBeInTheDocument();
    expect(screen.getByText('maps run fully local')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#1091' })).toHaveAttribute(
      'href',
      'https://github.com/connorgallopo/Tracearr/issues/1091'
    );
    expect(screen.getByText('settings:whatsNew.since:{"version":"v2.2.0"}')).toBeInTheDocument();
    expect(screen.queryByText('merged users stay merged')).not.toBeInTheDocument();
    expect(screen.getByText('settings:whatsNew.installedBadge')).toBeInTheDocument();
    expect(screen.getByText('settings:whatsNew.latestBadge')).toBeInTheDocument();
  });

  it('orders new before fix and renders backticks as code', () => {
    renderDialog();
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows[0]).toContain('settings:whatsNew.types.new');
    expect(screen.getByText('tracearr1.').tagName).toBe('CODE');
  });

  it('closes through Got it', () => {
    const onOpenChange = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'settings:whatsNew.gotIt' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('focuses the dialog content on open, not the first release row', () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('badges the release by base version on a beta build', () => {
    const release: ReleaseNotesFile = {
      version: '2.3.0',
      date: '2026-09-14',
      changes: [{ type: 'new', text: 'a new thing' }],
    };
    render(
      <WhatsNewDialog
        open
        onOpenChange={vi.fn()}
        mode="auto"
        sections={{ lead: [release], patches: [], since: null, earlier: [] }}
        runningVersion="2.3.0-beta.7"
        sinceVersion={null}
        latestVersion="v2.3.0-beta.7"
      />
    );
    expect(screen.getByText('settings:whatsNew.installedBadge')).toBeInTheDocument();
    expect(screen.getByText('settings:whatsNew.latestBadge')).toBeInTheDocument();
  });
});
