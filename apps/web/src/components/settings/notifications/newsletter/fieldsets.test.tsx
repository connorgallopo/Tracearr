import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Server } from '@tracearr/shared';
import { defaultFormState, type NewsletterFormState } from './newsletterForm';
import { IdentityFields } from './IdentityFields';
import { ScheduleFields } from './ScheduleFields';
import { ContentFields } from './ContentFields';
import { MessageFields } from './MessageFields';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/components/ui/rich-text-field', () => ({
  RichTextField: ({ id }: { id: string }) => <div data-testid={`rich-${id}`} />,
}));

vi.mock('@/hooks/queries', () => ({
  useServers: vi.fn(),
  useLibraries: vi.fn(),
}));

import { useLibraries, useServers } from '@/hooks/queries';

const servers = [
  { id: 's-1', name: 'Basement', type: 'plex' },
  { id: 's-2', name: 'Attic', type: 'jellyfin' },
] as Server[];

function props(over: Partial<NewsletterFormState> = {}) {
  const onChange = vi.fn();
  return {
    state: { ...defaultFormState(), ...over },
    onChange,
    errors: {},
    mode: 'create' as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useServers).mockReturnValue({ data: servers } as unknown as ReturnType<
    typeof useServers
  >);
  vi.mocked(useLibraries).mockReturnValue({
    data: {
      data: [
        {
          serverId: 's-1',
          serverName: 'Basement',
          libraryId: '1',
          name: 'Movies',
          mediaType: 'movie',
        },
        { serverId: 's-2', serverName: 'Attic', libraryId: '7', name: 'Shows', mediaType: 'show' },
      ],
    },
    isLoading: false,
  } as unknown as ReturnType<typeof useLibraries>);
});

describe('IdentityFields', () => {
  it('edits the name and the switch, worded for the mode', async () => {
    const p = props();
    render(<IdentityFields {...p} />);
    await userEvent.type(screen.getByLabelText('newsletters.editor.name'), 'W');
    expect(p.onChange).toHaveBeenCalledWith({ name: 'W' });
    expect(screen.getByRole('switch', { name: 'newsletters.editor.turnOnNow' })).toBeChecked();
    await userEvent.click(screen.getByRole('switch'));
    expect(p.onChange).toHaveBeenCalledWith({ enabled: false });
  });

  it('shows the field error and the edit-mode wording', () => {
    const p = { ...props(), errors: { name: 'Too short' }, mode: 'edit' as const };
    render(<IdentityFields {...p} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Too short');
    expect(screen.getByRole('switch', { name: 'newsletters.enabled' })).toBeInTheDocument();
  });
});

describe('ScheduleFields', () => {
  it('switches kinds and keeps the time, and cron replaces the clock with an expression', async () => {
    const p = props();
    const { rerender } = render(<ScheduleFields {...p} />);
    await userEvent.click(
      screen.getByRole('combobox', { name: 'newsletters.editor.scheduleKind' })
    );
    await userEvent.click(screen.getByRole('option', { name: 'newsletters.editor.kinds.monthly' }));
    expect(p.onChange).toHaveBeenCalledWith({
      schedule: { kind: 'monthly', dayOfMonth: 1, time: '09:00' },
    });

    rerender(
      <ScheduleFields
        {...p}
        state={{ ...p.state, schedule: { kind: 'cron', expression: '0 9 * * 1' } }}
      />
    );
    expect(screen.getByLabelText('newsletters.editor.cron')).toHaveValue('0 9 * * 1');
    expect(screen.queryByLabelText('newsletters.editor.time')).not.toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.cronHint')).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.dstNote')).toBeInTheDocument();
  });

  it('changes the time and the weekday, and shows the next run in edit mode', async () => {
    const p = props();
    render(<ScheduleFields {...p} mode="edit" nextRunAt="2026-09-07T07:00:00.000Z" />);
    const time = screen.getByLabelText('newsletters.editor.time');
    // A controlled time input reverts between keystrokes under a bare mock, so change the whole value at once.
    fireEvent.change(time, { target: { value: '18:30' } });
    expect(p.onChange).toHaveBeenLastCalledWith({
      schedule: { kind: 'weekly', dayOfWeek: 1, time: '18:30' },
    });
    await userEvent.click(screen.getByRole('combobox', { name: 'newsletters.editor.dayOfWeek' }));
    await userEvent.click(screen.getByRole('option', { name: 'Friday' }));
    expect(p.onChange).toHaveBeenLastCalledWith({
      schedule: { kind: 'weekly', dayOfWeek: 5, time: '09:00' },
    });
    expect(screen.getByText(/newsletters.editor.nextRun/)).toBeInTheDocument();
  });
});

describe('ContentFields', () => {
  it('edits the window, scopes servers, groups libraries by server, and flags an unknown library', async () => {
    const p = props({ scope: { serverIds: [], libraryIds: ['1', 'gone-9'] } });
    render(<ContentFields {...p} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'newsletters.editor.windowKind' }));
    await userEvent.click(screen.getByRole('option', { name: 'newsletters.editor.windows.fixed' }));
    expect(p.onChange).toHaveBeenCalledWith({ window: { kind: 'fixed', days: 7 } });

    await userEvent.click(screen.getByRole('combobox', { name: 'newsletters.editor.libraries' }));
    expect(screen.getByText('Basement')).toBeInTheDocument();
    expect(screen.getByText('Attic')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: /Shows/ }));
    expect(p.onChange).toHaveBeenCalledWith({
      scope: { serverIds: [], libraryIds: ['1', 'gone-9', '7'] },
    });

    const chip = screen.getByText('newsletters.editor.unknownLibrary');
    expect(chip).toHaveAttribute('title', 'gone-9');
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.removeLibrary:{"id":"gone-9"}' })
    );
    expect(p.onChange).toHaveBeenCalledWith({ scope: { serverIds: [], libraryIds: ['1'] } });
  });

  it('toggles a section and caps its count', async () => {
    const p = props();
    render(<ContentFields {...p} />);
    await userEvent.click(
      screen.getByRole('switch', { name: 'newsletters.editor.sections.mostWatched' })
    );
    expect(p.onChange).toHaveBeenCalledWith({
      sections: { ...p.state.sections, mostWatched: { enabled: true, max: 10 } },
    });
    const cap = screen.getByLabelText(
      'newsletters.editor.sectionMax:{"section":"newsletters.editor.sections.movies"}'
    );
    expect(cap).toHaveValue('12');
    expect(cap).toHaveAttribute('max', '12');
  });
});

describe('MessageFields', () => {
  it('shows the resolved sender name as the placeholder and stores a typed one', async () => {
    const p = props({ scope: { serverIds: ['s-2'], libraryIds: [] } });
    render(<MessageFields {...p} richTextErrors={{}} onRichText={vi.fn()} fieldKey="new" />);
    const shownAs = screen.getByLabelText('newsletters.editor.senderName');
    expect(shownAs).toHaveAttribute('placeholder', 'Attic');
    await userEvent.type(shownAs, 'F');
    expect(p.onChange).toHaveBeenCalledWith({ senderName: 'F' });
    expect(screen.getByText(/{{server_name}}/)).toBeInTheDocument();
    expect(await screen.findByTestId('rich-newsletter-intro')).toBeInTheDocument();
    expect(await screen.findByTestId('rich-newsletter-outro')).toBeInTheDocument();
  });

  it('falls back to Tracearr for two scoped servers and surfaces a rich text error', () => {
    const p = props();
    render(
      <MessageFields
        {...p}
        richTextErrors={{ outro: 'Too much formatting' }}
        onRichText={vi.fn()}
        fieldKey="new"
      />
    );
    expect(screen.getByLabelText('newsletters.editor.senderName')).toHaveAttribute(
      'placeholder',
      'Tracearr'
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Too much formatting');
  });
});
