import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HtmlPreviewDialog, withoutImages } from './HtmlPreviewDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: 'en-US' },
  }),
}));

const html =
  '<p>Hello</p><img src="https://tracearr.example/api/v1/images/proxy?a=1" alt="Heat"><img alt="x" src="cid:logo">';

describe('HtmlPreviewDialog', () => {
  it('renders the html in an empty-sandbox frame with a labelled subject, the meta block and the caller notice', () => {
    const { rerender } = render(
      <HtmlPreviewDialog
        open
        onOpenChange={vi.fn()}
        title="Preview"
        subject="What's new on Basement"
        meta={<p>12 movies</p>}
        html="<p>Hello</p>"
        notice="The links are filled in per recipient"
      />
    );
    const frame = screen.getByTitle('Preview');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame).toHaveAttribute('srcdoc', '<p>Hello</p>');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(screen.getByRole('heading', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByText("What's new on Basement")).toBeInTheDocument();
    expect(screen.getByText(/newsletters\.editor\.preview\.subjectLabel/)).toBeInTheDocument();
    expect(screen.getByText('12 movies')).toBeInTheDocument();
    expect(screen.getByText('The links are filled in per recipient')).toBeInTheDocument();
    expect(screen.queryByText('newsletters.editor.preview.draft')).not.toBeInTheDocument();

    // A sent copy passes no notice: its links really did go out.
    rerender(<HtmlPreviewDialog open onOpenChange={vi.fn()} title="Preview" html="<p>Hello</p>" />);
    expect(screen.queryByText('The links are filled in per recipient')).not.toBeInTheDocument();
  });

  it('shows the draft badge when asked', () => {
    render(<HtmlPreviewDialog open onOpenChange={vi.fn()} title="Preview" html="<p/>" draft />);
    expect(screen.getByText('newsletters.editor.preview.draft')).toBeInTheDocument();
  });

  it('strips every image source while Blocked is selected and restores it on Shown', async () => {
    render(<HtmlPreviewDialog open onOpenChange={vi.fn()} title="Preview" html={html} />);
    await userEvent.click(
      screen.getByRole('radio', { name: 'newsletters.editor.preview.imagesBlocked' })
    );
    const blocked = screen.getByTitle('Preview').getAttribute('srcdoc') ?? '';
    expect(blocked).not.toMatch(/<img[^>]*\ssrc=/);
    expect(blocked).toContain('alt="Heat"');
    expect(screen.getByText('newsletters.editor.preview.imagesBlockedNote')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('radio', { name: 'newsletters.editor.preview.imagesOn' })
    );
    expect(screen.getByTitle('Preview')).toHaveAttribute('srcdoc', html);
  });

  it('reopens on the shown images and the desktop width after a close', async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            reopen
          </button>
          <HtmlPreviewDialog open={open} onOpenChange={setOpen} title="Preview" html={html} />
        </>
      );
    }
    render(<Harness />);
    await userEvent.click(
      screen.getByRole('radio', { name: 'newsletters.editor.preview.imagesBlocked' })
    );
    await userEvent.click(
      screen.getByRole('radio', { name: 'newsletters.editor.preview.widths.phone' })
    );
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTitle('Preview')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'reopen' }));
    expect(screen.getByTitle('Preview')).toHaveAttribute('srcdoc', html);
    expect(screen.getByTitle('Preview')).toHaveStyle({ width: '600px' });
    expect(
      screen.queryByText('newsletters.editor.preview.imagesBlockedNote')
    ).not.toBeInTheDocument();
  });

  it('narrows the frame to 375 px on the phone width', async () => {
    render(<HtmlPreviewDialog open onOpenChange={vi.fn()} title="Preview" html={html} />);
    expect(screen.getByTitle('Preview')).toHaveStyle({ width: '600px' });
    await userEvent.click(
      screen.getByRole('radio', { name: 'newsletters.editor.preview.widths.phone' })
    );
    expect(screen.getByTitle('Preview')).toHaveStyle({ width: '375px' });
  });

  it('shows a skeleton while loading and no frame or toolbar without html', () => {
    const { rerender } = render(
      <HtmlPreviewDialog open onOpenChange={vi.fn()} title="Preview" html={null} loading />
    );
    expect(screen.queryByTitle('Preview')).not.toBeInTheDocument();
    expect(screen.getByTestId('html-preview-loading')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    rerender(<HtmlPreviewDialog open onOpenChange={vi.fn()} title="Preview" html={null} />);
    expect(screen.queryByTitle('Preview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('html-preview-loading')).not.toBeInTheDocument();
  });
});

describe('withoutImages', () => {
  it('drops src from every img and leaves the rest of the tag alone', () => {
    expect(withoutImages('<img class="p" src="a.png" alt="A"><IMG src=\'b\'>')).toBe(
      '<img class="p" alt="A"><IMG>'
    );
  });
});
