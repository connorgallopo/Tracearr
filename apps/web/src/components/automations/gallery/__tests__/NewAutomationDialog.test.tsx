import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { i18n, initI18n } from '@tracearr/translations';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { describeTemplate, describeText, type Translate } from '@/lib/automations';
import { previewOf, SHARE_CODE } from '../../sharing/__tests__/fixtures';
import { BLOCKED_COUNTRIES, TEMPLATES } from './fixtures';
import type { TemplatePreview } from '@/lib/api';

vi.mock('@/hooks/queries/useSettings', () => ({
  useSettings: () => ({ data: { unitSystem: 'metric' } }),
}));
vi.mock('@/hooks/useServer', () => ({ useServer: () => ({ servers: [] }) }));
vi.mock('@/hooks/queries/useUsers', () => ({ useUsers: () => ({ data: undefined }) }));
vi.mock('@/hooks/queries/useHistory', () => ({
  useAutomationFilterOptions: () => ({ data: undefined }),
}));
vi.mock('@/hooks/queries/useDestinations', () => ({ useDestinations: () => ({ data: [] }) }));

vi.mock('@/components/settings/destinations/DestinationDialog', () => ({
  DestinationDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Destination dialog</DialogTitle>
      </DialogContent>
    </Dialog>
  ),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const instantiate = vi.fn();
const store = vi.fn();
/** The paste step's own test drives the real mutation; here the answer just arrives. */
const check = vi.fn((_body: unknown, options?: { onSuccess?: (p: TemplatePreview) => void }) =>
  options?.onSuccess?.(previewOf())
);

vi.mock('@/hooks/queries/useTemplates', () => ({
  useTemplates: () => ({ data: TEMPLATES, isLoading: false, isError: false, refetch: vi.fn() }),
  useInstantiateTemplate: () => ({ mutate: instantiate, isPending: false }),
  usePreviewTemplate: () => ({ mutate: check, isPending: false }),
  useImportTemplate: () => ({ mutate: store, isPending: false }),
}));

import { toast } from 'sonner';
import { NewAutomationDialog } from '../NewAutomationDialog';

let t: Translate;

beforeAll(async () => {
  await initI18n({ lng: 'en' });
  t = i18n.getFixedT(null, 'pages');
});

beforeEach(() => {
  instantiate.mockReset();
  store.mockReset();
});

/** The builder route, saying what the second door carried across. */
function BuilderPage() {
  const { state } = useLocation();
  const draft = (state as { draft?: { name: string } } | null)?.draft;
  return <p>{draft ? `the builder page · ${draft.name}` : 'the builder page'}</p>;
}

function renderDialog(props: { templateId?: string } = {}) {
  const onOpenChange = vi.fn();
  render(
    <MemoryRouter initialEntries={['/automations']}>
      <Routes>
        <Route
          path="/automations"
          element={<NewAutomationDialog open onOpenChange={onOpenChange} {...props} />}
        />
        <Route path="/automations/new" element={<BuilderPage />} />
      </Routes>
    </MemoryRouter>
  );
  return { onOpenChange, user: userEvent.setup() };
}

const gallery = () => screen.getByRole('dialog');

describe('NewAutomationDialog', () => {
  it('lists the groups in ascending consequence, with the other ways in last', () => {
    renderDialog();

    const headings = [...gallery().querySelectorAll('[cmdk-group-heading]')].map(
      (node) => node.textContent
    );

    expect(headings).toEqual([
      'Notifications',
      'Server health',
      'Limits and rules',
      'Housekeeping',
      'Other ways to start',
    ]);
  });

  it('finds a template by a word only its synonyms carry', async () => {
    const { user } = renderDialog();

    await user.type(screen.getByRole('combobox'), 'kill');

    expect(screen.getByText('Stop paused streams')).toBeInTheDocument();
    expect(screen.queryByText('Server down')).not.toBeInTheDocument();
  });

  it('finds a template by a word only the tail of its long sentence carries', async () => {
    const { user } = renderDialog();
    // The capped sentence stops before the last clause; the search index must not.
    const capped = describeText(
      describeTemplate(BLOCKED_COUNTRIES.version, {}, {}, t, 'metric'),
      t
    );
    expect(capped).not.toContain('message the player');

    await user.type(screen.getByRole('combobox'), 'message the player');

    expect(screen.getByText('Blocked countries')).toBeInTheDocument();
  });

  it('puts the cursor back in the search box when / is pressed', async () => {
    const { user } = renderDialog();
    const search = screen.getByRole('combobox');

    screen.getByRole('button', { name: 'Close' }).focus();
    expect(search).not.toHaveFocus();

    await user.keyboard('/');

    expect(search).toHaveFocus();
  });

  it('gives the door rows the same states as a template row', () => {
    renderDialog();

    const door = screen.getByText('Paste a share code').closest('[data-slot="item"]');
    const template = screen.getByText('Stream started').closest('[data-slot="item"]');

    expect(door?.className).toContain('group-data-[selected=true]:bg-accent/40');
    expect(door?.className).toBe(template?.className);
    // cmdk marks the row above, so the class only reaches the row through `group`.
    expect(door?.closest('[cmdk-item]')).toHaveClass('group');
  });

  it('keeps the two other ways in when nothing matches', async () => {
    const { user } = renderDialog();

    await user.type(screen.getByRole('combobox'), 'zzzzz');

    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
    expect(screen.getByText('Paste a share code')).toBeInTheDocument();
    expect(screen.getByText('Start from scratch')).toBeInTheDocument();
  });

  it('swaps to the binding form when a card is picked', async () => {
    const { user } = renderDialog();

    await user.click(screen.getByText('Stream started'));

    expect(await screen.findByRole('heading', { name: 'Stream started' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use this' })).toBeInTheDocument();
  });

  it('opens straight into the binding form for a deep link', () => {
    renderDialog({ templateId: 'template-concurrent-streams' });

    expect(screen.getByRole('heading', { name: 'Too many streams at once' })).toBeInTheDocument();
  });

  it('falls back to the gallery when the deep link names nothing this server has', async () => {
    renderDialog({ templateId: 'template-nothing-here' });

    expect(await screen.findByText('Stream started')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('That ready-made automation is not on this server.');
  });

  it('sends Esc back to the gallery before it closes anything', async () => {
    const { onOpenChange, user } = renderDialog({ templateId: 'template-stream-started' });

    await user.keyboard('{Escape}');

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText('Server down')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('leaves the outer dialog alone when Esc closes the destination dialog on top', async () => {
    const { onOpenChange, user } = renderDialog({ templateId: 'template-stream-started' });

    await user.click(screen.getByRole('button', { name: 'New destination' }));
    expect(await screen.findByText('Destination dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Stream started' })).toBeInTheDocument();
  });

  it('takes the scratch row to the builder page', async () => {
    const { user } = renderDialog();

    await user.click(screen.getByText('Start from scratch'));

    expect(await screen.findByText('the builder page')).toBeInTheDocument();
  });

  it('takes the second door to the builder with the answers already given', async () => {
    const { onOpenChange, user } = renderDialog({ templateId: 'template-concurrent-streams' });

    await user.click(screen.getByRole('button', { name: 'Open in the builder' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(
      await screen.findByText('the builder page · Too many streams at once')
    ).toBeInTheDocument();
  });

  it('takes the paste row to the box, then to the review of what was pasted', async () => {
    const { user } = renderDialog();

    await user.click(screen.getByText('Paste a share code'));
    await user.type(await screen.findByRole('textbox', { name: 'Paste a share code' }), SHARE_CODE);
    await user.click(screen.getByRole('button', { name: 'Check it' }));

    expect(await screen.findByRole('heading', { name: 'Two places at once' })).toBeInTheDocument();
    expect(screen.getByText('Tracearr can read this code.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add it' })).toBeInTheDocument();
  });

  it('walks Esc back from the review to the box, then to the gallery, then out', async () => {
    const { onOpenChange, user } = renderDialog();

    await user.click(screen.getByText('Paste a share code'));
    await user.type(await screen.findByRole('textbox', { name: 'Paste a share code' }), SHARE_CODE);
    await user.click(screen.getByRole('button', { name: 'Check it' }));
    await screen.findByRole('heading', { name: 'Two places at once' });

    await user.keyboard('{Escape}');
    expect(await screen.findByRole('textbox', { name: 'Paste a share code' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(await screen.findByText('Stream started')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
