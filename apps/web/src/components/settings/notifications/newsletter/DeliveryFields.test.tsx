import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Destination, Settings } from '@tracearr/shared';
import { defaultFormState, type NewsletterFormState } from './newsletterForm';
import { DeliveryFields } from './DeliveryFields';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/queries', () => ({
  useDestinations: vi.fn(),
  useSettings: vi.fn(),
}));
vi.mock('@/components/settings/destinations/DestinationDialog', () => ({
  DestinationDialog: ({
    open,
    initialKind,
    onCreated,
  }: {
    open: boolean;
    initialKind?: string;
    onCreated?: (created: { id: string }) => void;
  }) =>
    open ? (
      <div>
        <span>dialog kind: {initialKind}</span>
        <button type="button" onClick={() => onCreated?.({ id: 'dest-new' })}>
          simulate created
        </button>
      </div>
    ) : null,
}));

import { useDestinations, useSettings } from '@/hooks/queries';

const discord = { id: 'd-2', name: 'Discord', type: 'discord', enabled: true } as Destination;
const postmark = { id: 'd-1', name: 'Postmark', type: 'email', enabled: true } as Destination;

function stateWith(over: Partial<NewsletterFormState> = {}): NewsletterFormState {
  return { ...defaultFormState(), ...over };
}

beforeEach(() => {
  vi.mocked(useSettings).mockReturnValue({
    data: { externalUrl: 'https://tracearr.example.com' } as Settings,
  } as unknown as ReturnType<typeof useSettings>);
});

describe('DeliveryFields without an email destination', () => {
  it('offers to add one in place and selects what the dialog creates', async () => {
    vi.mocked(useDestinations).mockReturnValue({ data: [discord] } as unknown as ReturnType<
      typeof useDestinations
    >);
    const onChange = vi.fn();
    render(
      <DeliveryFields
        state={defaultFormState()}
        onChange={onChange}
        errors={{}}
        mode="create"
        touch={vi.fn()}
        touched={{}}
      />
    );

    expect(screen.getByText('newsletters.noDestinationHint')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'newsletters.editor.delivery.destination' })
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'newsletters.addEmailDestination' }));
    expect(screen.getByText('dialog kind: email')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'simulate created' }));
    expect(onChange).toHaveBeenCalledWith({ destinationId: 'dest-new' });
  });
});

describe('DeliveryFields destination select with no destination chosen', () => {
  beforeEach(() => {
    vi.mocked(useDestinations).mockReturnValue({ data: [postmark] } as unknown as ReturnType<
      typeof useDestinations
    >);
  });

  it('shows None in edit mode, where a null destination was explicitly cleared', () => {
    render(
      <DeliveryFields
        state={stateWith()}
        onChange={vi.fn()}
        errors={{}}
        mode="edit"
        touch={vi.fn()}
        touched={{}}
      />
    );
    expect(
      screen.getByRole('combobox', { name: 'newsletters.editor.delivery.destination' })
    ).toHaveTextContent('newsletters.editor.delivery.noDestination');
  });

  it('shows the placeholder in create mode, where a null destination has never been touched', () => {
    render(
      <DeliveryFields
        state={stateWith()}
        onChange={vi.fn()}
        errors={{}}
        mode="create"
        touch={vi.fn()}
        touched={{}}
      />
    );
    const combobox = screen.getByRole('combobox', {
      name: 'newsletters.editor.delivery.destination',
    });
    expect(combobox).toHaveTextContent('newsletters.editor.delivery.pickDestination');
    expect(combobox).not.toHaveTextContent('newsletters.editor.delivery.noDestination');
  });

  it('choosing None in edit mode patches null and the trigger keeps reading None', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DeliveryFields
        state={stateWith({ destinationId: 'd-1' })}
        onChange={onChange}
        errors={{}}
        mode="edit"
        touch={vi.fn()}
        touched={{}}
      />
    );
    await userEvent.click(
      screen.getByRole('combobox', { name: 'newsletters.editor.delivery.destination' })
    );
    await userEvent.click(
      screen.getByRole('option', { name: 'newsletters.editor.delivery.noDestination' })
    );
    expect(onChange).toHaveBeenCalledWith({ destinationId: null });

    rerender(
      <DeliveryFields
        state={stateWith()}
        onChange={onChange}
        errors={{}}
        mode="edit"
        touch={vi.fn()}
        touched={{}}
      />
    );
    expect(
      screen.getByRole('combobox', { name: 'newsletters.editor.delivery.destination' })
    ).toHaveTextContent('newsletters.editor.delivery.noDestination');
  });

  it('keeps the select controlled in create mode once a pick is followed by None', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DeliveryFields
        state={stateWith()}
        onChange={onChange}
        errors={{}}
        mode="create"
        touch={vi.fn()}
        touched={{}}
      />
    );
    await userEvent.click(
      screen.getByRole('combobox', { name: 'newsletters.editor.delivery.destination' })
    );
    await userEvent.click(screen.getByRole('option', { name: 'Postmark' }));
    expect(onChange).toHaveBeenCalledWith({ destinationId: 'd-1' });

    rerender(
      <DeliveryFields
        state={stateWith({ destinationId: 'd-1' })}
        onChange={onChange}
        errors={{}}
        mode="create"
        touch={vi.fn()}
        touched={{ destinationId: true }}
      />
    );
    await userEvent.click(
      screen.getByRole('combobox', { name: 'newsletters.editor.delivery.destination' })
    );
    await userEvent.click(
      screen.getByRole('option', { name: 'newsletters.editor.delivery.noDestination' })
    );
    expect(onChange).toHaveBeenCalledWith({ destinationId: null });

    rerender(
      <DeliveryFields
        state={stateWith()}
        onChange={onChange}
        errors={{}}
        mode="create"
        touch={vi.fn()}
        touched={{ destinationId: true }}
      />
    );
    expect(
      screen.getByRole('combobox', { name: 'newsletters.editor.delivery.destination' })
    ).toHaveTextContent('newsletters.editor.delivery.noDestination');
  });
});

describe('DeliveryFields destination query states', () => {
  it('shows a skeleton while destinations are loading, not the empty-state add button', () => {
    vi.mocked(useDestinations).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useDestinations>);
    render(
      <DeliveryFields
        state={defaultFormState()}
        onChange={vi.fn()}
        errors={{}}
        mode="create"
        touch={vi.fn()}
        touched={{}}
      />
    );

    expect(
      screen.queryByRole('button', { name: 'newsletters.addEmailDestination' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'newsletters.editor.delivery.destination' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('newsletters.noDestinationHint')).not.toBeInTheDocument();
  });

  it('shows the query error instead of the empty-state add button', () => {
    vi.mocked(useDestinations).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('destinations request failed'),
    } as unknown as ReturnType<typeof useDestinations>);
    render(
      <DeliveryFields
        state={defaultFormState()}
        onChange={vi.fn()}
        errors={{}}
        mode="create"
        touch={vi.fn()}
        touched={{}}
      />
    );

    expect(screen.getByText('destinations request failed')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'newsletters.addEmailDestination' })
    ).not.toBeInTheDocument();
  });
});

describe('DeliveryFields image mode', () => {
  beforeEach(() => {
    vi.mocked(useDestinations).mockReturnValue({ data: [postmark] } as unknown as ReturnType<
      typeof useDestinations
    >);
  });

  it('offers hosted, attached and none, and shows a saved automatic row as attached', async () => {
    const onChange = vi.fn();
    render(
      <DeliveryFields
        state={stateWith({ imageMode: 'auto' })}
        onChange={onChange}
        errors={{}}
        mode="edit"
        touch={vi.fn()}
        touched={{}}
      />
    );
    const select = screen.getByRole('combobox', { name: 'newsletters.editor.delivery.imageMode' });
    expect(select).toHaveTextContent('newsletters.editor.delivery.modes.inline');
    expect(screen.getByText('newsletters.editor.delivery.modeHelp.inline')).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.delivery.modePreviewHint')).toBeInTheDocument();
    await userEvent.click(select);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'newsletters.editor.delivery.modes.hosted',
      'newsletters.editor.delivery.modes.inline',
      'newsletters.editor.delivery.modes.none',
    ]);
    await userEvent.click(
      screen.getByRole('option', { name: 'newsletters.editor.delivery.modes.none' })
    );
    expect(onChange).toHaveBeenCalledWith({ imageMode: 'none' });
  });

  it('drops the preview hint with posters off, names the destination as the sending account, and downgrades hosted without a URL', () => {
    vi.mocked(useSettings).mockReturnValue({
      data: { externalUrl: null } as Settings,
    } as unknown as ReturnType<typeof useSettings>);
    const { rerender } = render(
      <DeliveryFields
        state={stateWith({ imageMode: 'none' })}
        onChange={vi.fn()}
        errors={{}}
        mode="edit"
        touch={vi.fn()}
        touched={{}}
      />
    );
    expect(
      screen.queryByText('newsletters.editor.delivery.modePreviewHint')
    ).not.toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.delivery.destinationHelp')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    rerender(
      <DeliveryFields
        state={stateWith({ imageMode: 'hosted' })}
        onChange={vi.fn()}
        errors={{}}
        mode="edit"
        touch={vi.fn()}
        touched={{}}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'newsletters.editor.delivery.hostedNeedsUrl'
    );
  });
});
