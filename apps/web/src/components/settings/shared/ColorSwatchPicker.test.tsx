import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ColorSwatchPicker } from './ColorSwatchPicker';

const options = [
  { id: '187', name: 'Cyan', hex: '#18D1E7' },
  { id: '220', name: 'Blue', hex: '#3B82F6' },
  { id: '270', name: 'Purple', hex: '#8B5CF6' },
];

describe('ColorSwatchPicker', () => {
  it('is a labelled radio group of named swatches', () => {
    render(
      <ColorSwatchPicker label="Accent color" options={options} value="220" onChange={vi.fn()} />
    );

    expect(screen.getByRole('radiogroup', { name: 'Accent color' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Cyan' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
  });

  it('paints each swatch with its own hex', () => {
    render(
      <ColorSwatchPicker label="Accent color" options={options} value="220" onChange={vi.fn()} />
    );

    expect(screen.getByRole('radio', { name: 'Purple' })).toHaveStyle({
      backgroundColor: '#8B5CF6',
    });
  });

  it('reports the clicked swatch id', async () => {
    const onChange = vi.fn();
    render(
      <ColorSwatchPicker label="Accent color" options={options} value="220" onChange={onChange} />
    );

    await userEvent.click(screen.getByRole('radio', { name: 'Purple' }));

    expect(onChange).toHaveBeenCalledWith('270');
  });

  it('keeps one swatch in the tab order and moves selection with the arrow keys', async () => {
    const onChange = vi.fn();
    render(
      <ColorSwatchPicker label="Accent color" options={options} value="220" onChange={onChange} />
    );

    expect(screen.getByRole('radio', { name: 'Blue' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Cyan' })).toHaveAttribute('tabindex', '-1');

    await userEvent.tab();
    await userEvent.keyboard('{ArrowRight}');

    expect(onChange).toHaveBeenCalledWith('270');
  });

  it('wraps from the last swatch to the first', async () => {
    const onChange = vi.fn();
    render(
      <ColorSwatchPicker label="Accent color" options={options} value="270" onChange={onChange} />
    );

    await userEvent.tab();
    await userEvent.keyboard('{ArrowRight}');

    expect(onChange).toHaveBeenCalledWith('187');
  });
});
