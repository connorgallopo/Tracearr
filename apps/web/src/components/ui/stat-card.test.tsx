import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Play } from 'lucide-react';
import { StatCard } from './stat-card';

describe('StatCard', () => {
  it('fills its grid cell, so tiles in one row share a height', () => {
    render(<StatCard label="Hours watched" value="182h" />);
    const tile = screen.getByText('182h').closest('div.bg-card');
    expect(tile).toHaveClass('h-full');
    expect(tile).not.toHaveClass('self-start');
  });

  it('keeps a linked tile full height through its link', () => {
    render(
      <MemoryRouter>
        <StatCard label="Plays" value="12" href="/history" />
      </MemoryRouter>
    );
    expect(screen.getByRole('link')).toHaveClass('h-full');
  });

  it('steps up to the raised surface inside a card or a sheet', () => {
    render(<StatCard label="Plays" value="12" />);
    expect(screen.getByText('12').closest('div.bg-card')).toHaveClass(
      '[[data-slot=card]_&]:bg-card-raised',
      '[[data-slot=sheet-content]_&]:bg-card-raised'
    );
  });

  it('draws a 32px icon chip, a 20px value and a sentence-case muted label', () => {
    const { container } = render(<StatCard label="Plays" value="12" icon={Play} />);
    const chip = container.querySelector('.bg-primary\\/10');
    expect(chip).toHaveClass('size-8');
    expect(chip?.querySelector('svg')).toHaveClass('size-4');
    expect(screen.getByText('12')).toHaveClass('text-xl', 'font-semibold', 'tabular-nums');
    const labelLine = screen.getByText('Plays').parentElement;
    expect(labelLine).toHaveClass('text-dense', 'text-muted-foreground');
    expect(labelLine).not.toHaveClass('uppercase');
  });

  it('tightens padding, the chip and the value size on a compact tile', () => {
    const { container } = render(<StatCard label="Plays" value="12" compact icon={Play} />);
    expect(screen.getByText('12').closest('div.bg-card')).toHaveClass('px-3', 'py-2');
    expect(screen.getByText('12')).toHaveClass('text-lg');
    expect(container.querySelector('.bg-primary\\/10')).toHaveClass('size-7');
  });

  it('only truncates the value when asked, so durations like 1yr 23d 4h stay whole', () => {
    render(
      <>
        <StatCard label="Time" value="1yr 23d 4h" />
        <StatCard label="Show" value="A very long show title" truncateValue />
      </>
    );
    expect(screen.getByText('1yr 23d 4h')).not.toHaveClass('truncate');
    expect(screen.getByText('A very long show title')).toHaveClass('truncate');
  });

  it('renders a positive delta green with its comparison beside it, apart from the sub value', () => {
    render(
      <StatCard
        label="Plays"
        value={85}
        subValue="5 sessions"
        delta={{ value: 12, label: 'vs prior 30d' }}
      />
    );
    expect(screen.getByText('+12%')).toHaveClass('text-success');
    expect(screen.getByText('vs prior 30d')).toHaveClass('text-muted-foreground');
    expect(screen.getByText('vs prior 30d').parentElement).toBe(
      screen.getByText('+12%').parentElement
    );
    expect(screen.getByText('Plays').parentElement).toHaveTextContent(/^Plays · 5 sessions$/);
  });

  it('joins the sub value to the label line with a middle dot', () => {
    render(<StatCard label="Watch time" value="4h" subValue="Listen time 1h" />);
    expect(screen.getByText('Watch time').parentElement).toHaveTextContent(
      /^Watch time · Listen time 1h$/
    );
  });

  it('renders a negative delta red and a zero delta muted', () => {
    render(
      <>
        <StatCard label="Down" value={1} delta={{ value: -8 }} />
        <StatCard label="Flat" value={2} delta={{ value: 0 }} />
      </>
    );
    expect(screen.getByText(/^[-−]8%$/)).toHaveClass('text-destructive');
    expect(screen.getByText('0%')).toHaveClass('text-muted-foreground');
  });

  it('renders the value suffix in muted text after the value', () => {
    render(<StatCard label="Active" value={25} valueSuffix="of 43" />);
    expect(screen.getByText('of 43')).toHaveClass('text-muted-foreground');
  });
});
