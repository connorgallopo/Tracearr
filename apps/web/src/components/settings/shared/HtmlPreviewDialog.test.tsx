import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HtmlPreviewDialog } from './HtmlPreviewDialog';

describe('HtmlPreviewDialog', () => {
  it('renders the html in an iframe with an empty sandbox and the subject as the description', () => {
    render(
      <HtmlPreviewDialog
        open
        onOpenChange={vi.fn()}
        title="Preview"
        subject="What's new on Basement"
        meta={<p>12 movies</p>}
        html="<p>Hello</p>"
      />
    );
    const frame = screen.getByTitle('Preview');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame).toHaveAttribute('srcdoc', '<p>Hello</p>');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(screen.getByRole('heading', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByText("What's new on Basement")).toBeInTheDocument();
    expect(screen.getByText('12 movies')).toBeInTheDocument();
  });

  it('shows a skeleton while loading and no frame without html', () => {
    const { rerender } = render(
      <HtmlPreviewDialog open onOpenChange={vi.fn()} title="Preview" html={null} loading />
    );
    expect(screen.queryByTitle('Preview')).not.toBeInTheDocument();
    expect(screen.getByTestId('html-preview-loading')).toBeInTheDocument();
    rerender(<HtmlPreviewDialog open onOpenChange={vi.fn()} title="Preview" html={null} />);
    expect(screen.queryByTitle('Preview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('html-preview-loading')).not.toBeInTheDocument();
  });
});
