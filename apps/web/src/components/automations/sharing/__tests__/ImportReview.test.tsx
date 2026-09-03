import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import type { Automation, Destination } from '@tracearr/shared';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import type * as ApiModule from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const { ApiError } = await vi.importActual<typeof ApiModule>('@/lib/api');
  return { api: { templates: { create: vi.fn(), instantiate: vi.fn() } }, ApiError };
});

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('@/hooks/queries/useSettings', () => ({
  useSettings: () => ({ data: { unitSystem: 'metric' } }),
}));
vi.mock('@/hooks/useServer', () => ({
  useServer: () => ({ servers: [{ id: 'server-1', name: 'Beehive' }] }),
}));
vi.mock('@/hooks/queries/useUsers', () => ({ useUsers: () => ({ data: undefined }) }));
vi.mock('@/hooks/queries/useHistory', () => ({
  useAutomationFilterOptions: () => ({ data: undefined }),
}));

const destination: Destination = {
  id: 'dest-discord',
  name: 'Discord',
  type: 'discord',
  enabled: true,
  builtin: false,
  events: ['violation_detected'],
  configStatus: 'ok',
  config: { webhookUrl: null },
  secretsSet: ['webhookUrl'],
  referencedByAutomationCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('@/hooks/queries/useDestinations', () => ({
  useDestinations: () => ({ data: [destination] }),
}));

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
        <DialogTitle>New destination</DialogTitle>
      </DialogContent>
    </Dialog>
  ),
}));

import { api, type AutomationTemplate } from '@/lib/api';
import { ImportReview } from '../ImportReview';
import { previewOf, renderSharing, SHARE_CODE, SHARED_ENVELOPE } from './fixtures';

const create = vi.mocked(api.templates.create);
const instantiate = vi.mocked(api.templates.instantiate);

/** Only the id is read back, so the rest of the row is noise the test does without. */
const storedTemplate = { id: 'template-new' } as AutomationTemplate;
const createdAutomation = { id: 'automation-new', name: 'Two places at once' } as Automation;

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const onAdded = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue(storedTemplate);
  instantiate.mockResolvedValue(createdAutomation);
});

function renderReview(preview = previewOf()) {
  return renderSharing(
    <ImportReview
      preview={preview}
      code={SHARE_CODE}
      onAdded={onAdded}
      onBack={vi.fn()}
      backLabel="Back"
    />
  );
}

/** Every review needs its one required destination before it can be added. */
async function bindDestination(user: ReturnType<typeof renderReview>['user']) {
  await user.click(screen.getByRole('button', { name: 'Discord' }));
}

const addIt = () => screen.getByRole('button', { name: 'Add it' });

describe('ImportReview', () => {
  it('says only that it can read the code, and says who cannot vouch for it', () => {
    renderReview();

    expect(screen.getByText('Tracearr can read this code.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Nothing in a code says who wrote it or whether it is safe. The steps are below.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/Author: moviesRus, as written in the code/)).toBeInTheDocument();
    expect(screen.getByText(/Code 4f2a…c13/)).toBeInTheDocument();
    // The tick is muted until something is actually verified.
    expect(screen.getByText('Tracearr can read this code.').querySelector('svg')).toHaveClass(
      'text-muted-foreground'
    );
    // A pasted code has nobody vouching for it, and the absence is the message.
    expect(screen.queryByText('Built-in')).not.toBeInTheDocument();
    expect(screen.queryByText(/Verified/)).not.toBeInTheDocument();
  });

  it('keeps the green tick for a fingerprint that matches one Tracearr ships', () => {
    renderReview(
      previewOf({
        existing: {
          templateId: 'template-builtin',
          version: 1,
          name: 'Two places at once',
          builtin: true,
          fingerprintMatch: true,
        },
      })
    );

    expect(
      screen.getByText('This is Two places at once, one of the automations Tracearr ships.')
    ).toBeInTheDocument();
    expect(
      screen
        .getByText('This is Two places at once, one of the automations Tracearr ships.')
        .querySelector('svg')
    ).toHaveClass('text-success');
    expect(screen.queryByText(/Nothing in a code says who wrote it/)).not.toBeInTheDocument();
  });

  it('reads the consequences off the definition, branch and all', () => {
    renderReview();

    expect(screen.getByRole('region', { name: 'What this will do' })).toBeInTheDocument();
    // The kill sits inside an `if`, and it counts the same as one at the top.
    expect(screen.getByText('Can stop a stream that is playing.')).toBeInTheDocument();
    expect(screen.getByText('Records a violation against the matched person.')).toBeInTheDocument();
    expect(screen.getByText('Runs on every server unless one is chosen.')).toBeInTheDocument();
  });

  it('asks for the parts the code cannot carry', () => {
    renderReview();

    expect(screen.getByRole('region', { name: 'What it needs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discord' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Which server' })).toBeInTheDocument();
  });

  it('lands paused, and writes the template before the automation', async () => {
    const { user } = renderReview();

    expect(screen.getByRole('switch', { name: /Start paused/ })).toBeChecked();

    await bindDestination(user);
    await user.click(addIt());

    await waitFor(() => expect(instantiate).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({ code: SHARE_CODE });
    expect(instantiate).toHaveBeenCalledWith('template-new', {
      inputs: { to: ['dest-discord'] },
      isActive: false,
    });
    expect(onAdded).toHaveBeenCalled();
  });

  it('lands running when the reader turns the switch off', async () => {
    const { user } = renderReview();

    await bindDestination(user);
    await user.click(screen.getByRole('switch', { name: /Start paused/ }));
    await user.click(addIt());

    await waitFor(() => expect(instantiate).toHaveBeenCalled());
    expect(instantiate.mock.calls[0]?.[1]).toMatchObject({ isActive: true });
  });

  it('reveals a missing answer instead of sending an unbound import', async () => {
    const { user } = renderReview();

    await user.click(addIt());

    expect(await screen.findByText('Pick at least one.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('writes nothing when the library already holds this exact one', async () => {
    const { user } = renderReview(
      previewOf({
        existing: {
          templateId: 'template-known',
          version: 2,
          name: 'Two places at once',
          builtin: false,
          fingerprintMatch: true,
        },
      })
    );

    expect(screen.getByText('Already saved as Two places at once.')).toBeInTheDocument();

    await bindDestination(user);
    await user.click(screen.getByRole('button', { name: 'Use it' }));

    await waitFor(() =>
      expect(instantiate).toHaveBeenCalledWith('template-known', expect.anything())
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('offers both ways out of a name collision, and keeps both by default', async () => {
    const { user } = renderReview(
      previewOf({
        existing: {
          templateId: 'template-mine',
          version: 1,
          name: 'Two places at once',
          builtin: false,
          fingerprintMatch: false,
        },
      })
    );

    expect(
      screen.getByText('A different automation named Two places at once already exists.')
    ).toBeInTheDocument();

    await bindDestination(user);
    await user.click(addIt());

    await waitFor(() => expect(create).toHaveBeenCalledWith({ code: SHARE_CODE }));
  });

  it('replaces the one already there when the reader picks that', async () => {
    const { user } = renderReview(
      previewOf({
        existing: {
          templateId: 'template-mine',
          version: 1,
          name: 'Two places at once',
          builtin: false,
          fingerprintMatch: false,
        },
      })
    );

    await user.click(screen.getByRole('radio', { name: 'Replace mine' }));
    await bindDestination(user);
    await user.click(addIt());

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ code: SHARE_CODE, replace: 'template-mine' })
    );
  });

  it('never offers to replace a built-in', () => {
    renderReview(
      previewOf({
        existing: {
          templateId: 'template-builtin',
          version: 1,
          name: 'Two places at once',
          builtin: true,
          fingerprintMatch: false,
        },
      })
    );

    expect(screen.getByRole('radio', { name: 'Keep both' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Replace mine' })).not.toBeInTheDocument();
  });

  it('shows the whole envelope for anyone who wants to read it', async () => {
    const { user } = renderReview();

    await user.click(screen.getByRole('button', { name: 'Show the JSON' }));

    expect(screen.getByText(/"slug": "two-places-at-once"/)).toBeInTheDocument();
  });

  it('sends the answers alone, leaving the steps to the server', async () => {
    const { user } = renderReview();

    await bindDestination(user);
    await user.click(addIt());

    await waitFor(() => expect(instantiate).toHaveBeenCalled());
    // The cooldown the envelope carries survives because the client never rebuilds it.
    expect(Object.keys(instantiate.mock.calls[0]?.[1] ?? {}).sort()).toEqual([
      'inputs',
      'isActive',
    ]);
  });

  it('sends the envelope when there was no code to paste', async () => {
    const { user } = renderSharing(
      <ImportReview
        preview={previewOf()}
        code={null}
        onAdded={onAdded}
        onBack={vi.fn()}
        backLabel="Back"
      />
    );

    await bindDestination(user);
    await user.click(addIt());

    await waitFor(() => expect(create).toHaveBeenCalledWith({ envelope: SHARED_ENVELOPE }));
  });
});
