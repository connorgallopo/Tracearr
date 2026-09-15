import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card, CardContent, CardHeader, CardTitle } from './card';

describe('Card', () => {
  it('stacks header and content at a 16px gap with no phantom header row', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Only a title</CardTitle>
        </CardHeader>
        <CardContent>body</CardContent>
      </Card>
    );

    const header = screen.getByText('Only a title').closest('[data-slot="card-header"]');
    const card = header?.closest('[data-slot="card"]');
    expect(card).toHaveClass('gap-4');
    expect(card).not.toHaveClass('gap-6');
    expect(header).toHaveClass('auto-rows-min');
    expect(header).not.toHaveClass('grid-rows-[auto_auto]');
  });
});
