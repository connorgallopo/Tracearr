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
  RichTextField: ({ id, placeholder }: { id: string; placeholder?: string }) => (
    <div data-testid={`rich-${id}`}>{placeholder}</div>
  ),
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
    touch: vi.fn(),
    touched: {},
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
        { serverId: 's-2', serverName: 'Attic', libraryId: '1', name: 'Anime', mediaType: 'show' },
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

  it('marks the name touched when the input is left', async () => {
    const p = props();
    render(<IdentityFields {...p} />);
    await userEvent.type(screen.getByLabelText('newsletters.editor.name'), 'W');
    await userEvent.tab();
    expect(p.touch).toHaveBeenCalledWith('name');
  });
});

describe('ScheduleFields', () => {
  const year = new Date().getFullYear();

  it('switches kinds and keeps the time, explains the 28-day cap for monthly, and cron replaces the clock with an expression', async () => {
    const p = props();
    const { rerender } = render(<ScheduleFields {...p} scheduleDirty={false} />);
    await userEvent.click(
      screen.getByRole('combobox', { name: 'newsletters.editor.scheduleKind' })
    );
    await userEvent.click(screen.getByRole('option', { name: 'newsletters.editor.kinds.monthly' }));
    expect(p.onChange).toHaveBeenCalledWith({
      schedule: { kind: 'monthly', dayOfMonth: 1, time: '09:00' },
    });
    expect(p.touch).toHaveBeenCalledWith('schedule');

    rerender(
      <ScheduleFields
        {...p}
        scheduleDirty
        state={{ ...p.state, schedule: { kind: 'monthly', dayOfMonth: 1, time: '09:00' } }}
      />
    );
    expect(screen.getByText('newsletters.editor.dayOfMonthHelp')).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.timezoneHelp')).toBeInTheDocument();

    rerender(
      <ScheduleFields
        {...p}
        scheduleDirty
        state={{ ...p.state, schedule: { kind: 'cron', expression: '0 9 * * 1' } }}
      />
    );
    expect(screen.getByLabelText('newsletters.editor.cron')).toHaveValue('0 9 * * 1');
    expect(screen.queryByLabelText('newsletters.editor.time')).not.toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.cronHint')).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.dstNote')).toBeInTheDocument();
  });

  it('changes the time and the weekday', async () => {
    const p = props();
    render(<ScheduleFields {...p} scheduleDirty={false} />);
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
  });

  it('marks the time field invalid when the weekly schedule is rejected', () => {
    const p = { ...props(), errors: { schedule: 'Pick a time' } };
    render(<ScheduleFields {...p} scheduleDirty={false} />);
    const time = screen.getByLabelText('newsletters.editor.time');
    expect(time).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a time');
  });

  it('shows the next run in the newsletter zone for a saved schedule and says it is set on save otherwise', () => {
    const p = props({ timezone: 'Europe/Berlin' });
    const { rerender } = render(
      <ScheduleFields
        {...p}
        mode="edit"
        nextRunAt={`${year}-09-07T07:00:00.000Z`}
        scheduleDirty={false}
      />
    );
    expect(
      screen.getByText(
        'newsletters.editor.nextRun:{"when":"Sep 7, 9:00 AM","timezone":"Europe/Berlin"}'
      )
    ).toBeInTheDocument();

    rerender(
      <ScheduleFields {...p} mode="edit" nextRunAt={`${year}-09-07T07:00:00.000Z`} scheduleDirty />
    );
    expect(screen.getByText('newsletters.editor.nextRunPending')).toBeInTheDocument();

    rerender(<ScheduleFields {...p} mode="create" scheduleDirty={false} />);
    expect(screen.getByText('newsletters.editor.nextRunPending')).toBeInTheDocument();

    rerender(<ScheduleFields {...p} mode="edit" nextRunAt={null} scheduleDirty={false} />);
    expect(screen.getByText('newsletters.noNextRun')).toBeInTheDocument();
  });
});

describe('ContentFields', () => {
  it('edits the window as a sentence, keeps the same library id on two servers apart, and flags an unknown pair', async () => {
    const p = props({
      scope: {
        serverIds: [],
        libraries: [
          { serverId: 's-1', libraryId: '1' },
          { serverId: 's-9', libraryId: 'gone-9' },
        ],
      },
    });
    const { rerender } = render(<ContentFields {...p} />);
    expect(screen.getByText('newsletters.editor.windowSentence.fallback')).toBeInTheDocument();
    expect(
      screen.getByLabelText('newsletters.editor.windowSentence.fallbackLabel:{"count":7}')
    ).toHaveValue('7');
    expect(screen.getByText('newsletters.editor.windowHelp.since_last_send')).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.windowMax')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'newsletters.editor.windowKind' }));
    await userEvent.click(screen.getByRole('option', { name: 'newsletters.editor.windows.fixed' }));
    expect(p.onChange).toHaveBeenCalledWith({ window: { kind: 'fixed', days: 7 } });

    rerender(<ContentFields {...p} state={{ ...p.state, window: { kind: 'fixed', days: 7 } }} />);
    expect(screen.getByText('newsletters.editor.windowSentence.fixed')).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.windowSentence.fixedAfter')).toBeInTheDocument();
    expect(
      screen.getByLabelText('newsletters.editor.windowSentence.fixedLabel:{"count":7}')
    ).toHaveValue('7');
    expect(screen.getByText('newsletters.editor.windowHelp.fixed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('combobox', { name: 'newsletters.editor.libraries' }));
    expect(screen.getByText('Basement')).toBeInTheDocument();
    expect(screen.getByText('Attic')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await userEvent.click(screen.getByRole('option', { name: /Anime/ }));
    expect(p.onChange).toHaveBeenCalledWith({
      scope: {
        serverIds: [],
        libraries: [
          { serverId: 's-1', libraryId: '1' },
          { serverId: 's-9', libraryId: 'gone-9' },
          { serverId: 's-2', libraryId: '1' },
        ],
      },
    });

    const chip = screen.getByText('newsletters.editor.unknownLibrary');
    expect(chip).toHaveAttribute('title', 'gone-9');
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.removeLibrary:{"id":"gone-9"}' })
    );
    expect(p.onChange).toHaveBeenCalledWith({
      scope: { serverIds: [], libraries: [{ serverId: 's-1', libraryId: '1' }] },
    });
    expect(screen.getByText('newsletters.editor.librariesHelp')).toBeInTheDocument();
  });

  it("names each cap as a sentence with the right noun, disables a section's numbers when it is off and keeps their values", async () => {
    const p = props({
      sections: {
        ...defaultFormState().sections,
        movies: { enabled: false, max: 9 },
      },
    });
    render(<ContentFields {...p} />);
    const movies = screen.getByLabelText('newsletters.editor.sections.labels.movies:{"count":9}');
    expect(movies).toBeDisabled();
    expect(movies).toHaveValue('9');
    expect(movies).toHaveAttribute('max', '12');
    expect(
      screen.getByLabelText('newsletters.editor.sections.labels.shows:{"count":12}')
    ).toBeEnabled();
    expect(
      screen.getByLabelText('newsletters.editor.sections.labels.seasons:{"count":8}')
    ).toHaveValue('8');
    expect(
      screen.getByLabelText('newsletters.editor.sections.labels.music:{"count":8}')
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('newsletters.editor.sections.labels.mostWatched:{"count":10}')
    ).toBeDisabled();
    expect(screen.getByText('newsletters.editor.sections.units.albums')).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.sections.musicHelp')).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.sections.mostWatchedHelp')).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.sections.description')).toBeInTheDocument();
    expect(screen.queryByText('newsletters.editor.sectionsHelp')).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('switch', { name: 'newsletters.editor.sections.mostWatched' })
    );
    expect(p.onChange).toHaveBeenCalledWith({
      sections: { ...p.state.sections, mostWatched: { enabled: true, max: 10 } },
    });
    expect(p.touch).toHaveBeenCalledWith('sections');
  });

  it('says what the servers select decides, for one server and for several', () => {
    const { unmount } = render(<ContentFields {...props()} />);
    expect(screen.getByText('newsletters.editor.variantsNote')).toBeInTheDocument();
    expect(screen.queryByText('newsletters.editor.serversHelp')).not.toBeInTheDocument();
    unmount();
    render(<ContentFields {...props({ scope: { serverIds: ['s-2'], libraries: [] } })} />);
    expect(screen.getByText('newsletters.editor.serversHelp')).toBeInTheDocument();
    expect(screen.queryByText('newsletters.editor.variantsNote')).not.toBeInTheDocument();
  });
});

describe('MessageFields', () => {
  it('shows the resolved sender as the placeholder with its help for one server, explains each subject token on its own line, and locates intro and outro', async () => {
    const p = props({ scope: { serverIds: ['s-2'], libraries: [] } });
    render(<MessageFields {...p} richTextErrors={{}} onRichText={vi.fn()} fieldKey="new" />);
    const fromName = screen.getByLabelText('newsletters.editor.senderName');
    expect(fromName).toHaveAttribute('placeholder', 'Attic');
    expect(
      screen.getByText('newsletters.editor.senderNameHelp:{"name":"Attic"}')
    ).toBeInTheDocument();
    await userEvent.type(fromName, 'F');
    expect(p.onChange).toHaveBeenCalledWith({ senderName: 'F' });
    await userEvent.tab();
    expect(p.touch).toHaveBeenCalledWith('senderName');

    expect(screen.getByText('newsletters.editor.subjectHelp')).toBeInTheDocument();
    const lines = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(lines).toEqual([
      '{{server_name}}: newsletters.editor.placeholders.server_name',
      '{{start_date}}: newsletters.editor.placeholders.start_date',
      '{{end_date}}: newsletters.editor.placeholders.end_date',
      '{{item_count}}: newsletters.editor.placeholders.item_count',
    ]);
    expect(await screen.findByTestId('rich-newsletter-intro')).toHaveTextContent(
      'newsletters.editor.introPlaceholder'
    );
    expect(await screen.findByTestId('rich-newsletter-outro')).toHaveTextContent(
      'newsletters.editor.outroPlaceholder'
    );
  });

  it('falls back to Tracearr for two scoped servers, hides the leave-it-empty help, and surfaces a rich text error', () => {
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
    expect(screen.queryByText(/newsletters\.editor\.senderNameHelp/)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Too much formatting');
  });
});
