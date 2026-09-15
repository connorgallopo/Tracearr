import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import type * as ApiModule from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const { ApiError } = await vi.importActual<typeof ApiModule>('@/lib/api');
  return { api: { templates: { preview: vi.fn() } }, ApiError };
});

import { api, ApiError } from '@/lib/api';
import { ImportPasteStep } from '../ImportPasteStep';
import { previewOf, renderSharing, SHARE_CODE, SHARED_ENVELOPE } from './fixtures';

const preview = vi.mocked(api.templates.preview);

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const onChecked = vi.fn();
const onBack = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function renderStep() {
  return renderSharing(<ImportPasteStep onChecked={onChecked} onBack={onBack} backLabel="Back" />);
}

const box = () => screen.getByRole('textbox', { name: 'Paste a share code' });
const checkIt = () => screen.getByRole('button', { name: 'Check it' });

describe('ImportPasteStep', () => {
  it('says where codes come from, and links out to the gallery it names', () => {
    renderStep();

    expect(
      screen.getByText('Shared automations are listed at docs.tracearr.com/templates.')
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the gallery/ })).toHaveAttribute(
      'href',
      'https://docs.tracearr.com/templates'
    );
    expect(screen.getByText('A code starts with tracearr1.')).toBeInTheDocument();
  });

  it('waits for something to read before it offers to read it', async () => {
    const { user } = renderStep();

    expect(checkIt()).toBeDisabled();

    await user.type(box(), SHARE_CODE);
    expect(checkIt()).toBeEnabled();
  });

  it('sends a share code as a code and hands the answer back', async () => {
    const answer = previewOf();
    preview.mockResolvedValue(answer);
    const { user } = renderStep();

    await user.type(box(), `  ${SHARE_CODE}  `);
    await user.click(checkIt());

    await waitFor(() => expect(onChecked).toHaveBeenCalled());
    expect(preview).toHaveBeenCalledWith({ code: SHARE_CODE });
    expect(onChecked).toHaveBeenCalledWith({ preview: answer, code: SHARE_CODE });
  });

  it('sends pasted JSON as an envelope, with no code to show', async () => {
    preview.mockResolvedValue(previewOf());
    const { user } = renderStep();

    await user.click(box());
    await user.paste(JSON.stringify(SHARED_ENVELOPE));
    await user.click(checkIt());

    await waitFor(() => expect(onChecked).toHaveBeenCalled());
    expect(preview).toHaveBeenCalledWith({ envelope: SHARED_ENVELOPE });
    expect(onChecked.mock.calls[0]?.[0]).toMatchObject({ code: null });
  });

  it.each([
    ['prefix', "That doesn't look like a Tracearr share code."],
    ['too_long', "That's too big to be a Tracearr automation."],
    ['incomplete', 'This code looks cut off.'],
    ['too_deep', "Tracearr couldn't read this one."],
    ['invalid_json', "Tracearr couldn't read this one."],
  ])('says what went wrong when the server answers %s', async (reason, message) => {
    preview.mockRejectedValue(new ApiError('nope', 400, { message: 'nope', reason }));
    const { user } = renderStep();

    await user.type(box(), SHARE_CODE);
    await user.click(checkIt());

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(onChecked).not.toHaveBeenCalled();
    // The paste stays put, so a broken code can be fixed rather than re-copied.
    expect(box()).toHaveValue(SHARE_CODE);
  });

  it('treats a rejected envelope with no reason as one it could not read', async () => {
    preview.mockRejectedValue(new ApiError('Invalid template: bad', 400));
    const { user } = renderStep();

    await user.type(box(), SHARE_CODE);
    await user.click(checkIt());

    expect(await screen.findByRole('alert')).toHaveTextContent("Tracearr couldn't read this one.");
  });

  it('says to wait when the server has had too many codes this minute', async () => {
    preview.mockRejectedValue(new ApiError('Too Many Requests', 429));
    const { user } = renderStep();

    await user.type(box(), SHARE_CODE);
    await user.click(checkIt());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("That's a lot of codes in one minute.");
    expect(alert).toHaveTextContent('Wait a moment, then check it again.');
  });

  it('sends a pasted link as the text it is, and fetches nothing', async () => {
    preview.mockRejectedValue(
      new ApiError('This is not a Tracearr share code', 400, { reason: 'prefix' })
    );
    const url = 'https://example.com/x.json';
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const { user } = renderStep();

    await user.click(box());
    await user.paste(url);
    await user.click(checkIt());

    // A URL is not a way in: it goes to our own server as text and comes back refused.
    expect(preview).toHaveBeenCalledWith({ code: url });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That doesn't look like a Tracearr share code."
    );
    expect(network).not.toHaveBeenCalled();
  });

  it('stops a code this server is too old for, naming both versions', async () => {
    preview.mockResolvedValue(
      previewOf({ minServerVersion: { required: '2.4.0', current: '2.2.0', satisfied: false } })
    );
    const { user } = renderStep();

    await user.type(box(), SHARE_CODE);
    await user.click(checkIt());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This needs Tracearr 2.4.0 or newer.');
    expect(alert).toHaveTextContent('This server runs 2.2.0.');
    expect(onChecked).not.toHaveBeenCalled();
  });

  it('turns away more text than a share code can hold without asking the server', async () => {
    const { user } = renderStep();

    await user.click(box());
    await user.paste(`tracearr1.${'a'.repeat(65536)}`);
    await user.click(checkIt());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That's too big to be a Tracearr automation."
    );
    expect(preview).not.toHaveBeenCalled();
  });

  it('says nothing about the shape of what was typed until the button is pressed', async () => {
    const { user } = renderStep();

    await user.type(box(), 'not a code at all');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('goes back the way it came', async () => {
    const { user } = renderStep();

    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(onBack).toHaveBeenCalled();
  });
});
