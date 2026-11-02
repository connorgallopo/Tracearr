import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileDropzone } from './FileDropzone';

describe('FileDropzone', () => {
  it('opens the file picker from the keyboard', async () => {
    const user = userEvent.setup();
    const pick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    render(<FileDropzone onFileSelect={vi.fn()} selectedFile={null} />);

    const dropzone = screen.getByRole('button', { name: /import\.dropzone\.dragOrClick/ });
    dropzone.focus();
    expect(dropzone).toHaveFocus();

    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(pick).toHaveBeenCalledTimes(2);
    pick.mockRestore();
  });
});
