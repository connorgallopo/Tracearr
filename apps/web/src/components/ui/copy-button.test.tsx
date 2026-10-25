import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyButton, copyText } from './copy-button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

import { toast } from 'sonner';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

describe('CopyButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete (navigator as { clipboard?: Clipboard }).clipboard;
  });

  it('puts the value on the clipboard', async () => {
    const user = userEvent.setup();
    render(<CopyButton value="tracearr-api-key" label="Copy API key" />);

    await user.click(screen.getByRole('button', { name: 'Copy API key' }));

    await expect(navigator.clipboard.readText()).resolves.toBe('tracearr-api-key');
  });

  it('confirms with a check icon, then returns to the copy icon', async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    const { container } = render(<CopyButton value="abc" label="Copy token" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    });

    expect(container.querySelector('.lucide-check')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(container.querySelector('.lucide-check')).toBeNull();
    expect(container.querySelector('.lucide-copy')).toBeInTheDocument();
  });

  it('asks for a manual copy when the browser refuses the clipboard', async () => {
    const user = userEvent.setup();
    render(<CopyButton value="abc" label="Copy token" />);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

    await user.click(screen.getByRole('button', { name: 'Copy token' }));

    expect(toast.error).toHaveBeenCalledWith('toast.error.copyManual');
  });

  it('keeps the icon-only shape by default and writes the label beside it on request', () => {
    const { rerender } = render(<CopyButton value="abc" label="Copy the share code" />);

    expect(screen.getByRole('button', { name: 'Copy the share code' })).toHaveTextContent('');

    rerender(<CopyButton value="abc" label="Copy the share code" showLabel />);

    expect(screen.getByRole('button', { name: 'Copy the share code' })).toHaveTextContent(
      'Copy the share code'
    );
  });

  it('shows its children instead of the label and still copies the value', async () => {
    const user = userEvent.setup();
    render(
      <CopyButton value="123456" label="Copy code">
        123456
      </CopyButton>
    );

    const button = screen.getByRole('button', { name: 'Copy code' });
    expect(button).toHaveTextContent('123456');
    expect(button).toHaveAttribute('data-size', 'default');

    await user.click(button);

    await expect(navigator.clipboard.readText()).resolves.toBe('123456');
  });

  it('does not copy while disabled', async () => {
    const user = userEvent.setup();
    render(<CopyButton value="abc" label="Copy token" disabled />);

    await user.click(screen.getByRole('button', { name: 'Copy token' }));

    await expect(navigator.clipboard.readText()).resolves.toBe('');
  });
});

describe('copyText', () => {
  const originalSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
  const originalExec = Object.getOwnPropertyDescriptor(document, 'execCommand');

  const stub = (secure: boolean, clipboard: unknown, exec: () => boolean) => {
    Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
    const execCommand = vi.fn(exec);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    return execCommand;
  };

  afterEach(() => {
    if (originalSecure) Object.defineProperty(window, 'isSecureContext', originalSecure);
    else delete (window as { isSecureContext?: boolean }).isSecureContext;
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete (navigator as { clipboard?: Clipboard }).clipboard;
    if (originalExec) Object.defineProperty(document, 'execCommand', originalExec);
    else delete (document as { execCommand?: unknown }).execCommand;
    window.getSelection()?.removeAllRanges();
  });

  it('uses navigator.clipboard in a secure context', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = stub(true, { writeText }, () => true);

    await expect(copyText('abc')).resolves.toBe('copied');

    expect(writeText).toHaveBeenCalledWith('abc');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('falls back to execCommand without navigator.clipboard', async () => {
    let copiedValue = '';
    const execCommand = stub(false, undefined, () => {
      copiedValue = document.querySelector('textarea')?.value ?? '';
      return true;
    });

    await expect(copyText('abc')).resolves.toBe('copied');

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copiedValue).toBe('abc');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back when writeText throws', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    const execCommand = stub(true, { writeText }, () => true);

    await expect(copyText('abc')).resolves.toBe('copied');

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('asks for a manual copy when both fail', async () => {
    const user = userEvent.setup();
    stub(false, undefined, () => false);
    render(
      <>
        <code data-testid="shown">/mnt/cache/appdata</code>
        <CopyButton
          value="/mnt/cache/appdata"
          label="Copy path"
          selectTarget={() => screen.getByTestId('shown')}
        />
      </>
    );

    await user.click(screen.getByRole('button', { name: 'Copy path' }));

    expect(toast.error).toHaveBeenCalledWith('toast.error.copyManual');
    expect(window.getSelection()?.toString()).toBe('/mnt/cache/appdata');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('selects an input target with its own selection', async () => {
    const user = userEvent.setup();
    stub(false, undefined, () => false);
    render(
      <>
        <input readOnly value="pair-token-123" data-testid="shown" />
        <CopyButton
          value="pair-token-123"
          label="Copy token"
          selectTarget={() => screen.getByTestId('shown')}
        />
      </>
    );

    await user.click(screen.getByRole('button', { name: 'Copy token' }));

    const input = screen.getByTestId<HTMLInputElement>('shown');
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'pair-token-123'.length]);
  });

  it('copies from inside an open modal dialog and returns focus to the button', async () => {
    const user = userEvent.setup();
    let focusedAtCopy: Element | null = null;
    stub(false, undefined, () => {
      focusedAtCopy = document.activeElement;
      return true;
    });
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Description</DialogDescription>
          <CopyButton value="abc" label="Copy path" />
        </DialogContent>
      </Dialog>
    );
    const button = screen.getByRole('button', { name: 'Copy path' });

    await user.click(button);

    expect(focusedAtCopy).toBeInstanceOf(HTMLTextAreaElement);
    expect(toast.error).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
  });
});
