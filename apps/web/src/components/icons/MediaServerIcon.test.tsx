import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SERVER_TYPES } from '@tracearr/shared';
import { MediaServerIcon } from './MediaServerIcon';

describe('MediaServerIcon', () => {
  it.each(SERVER_TYPES)('shows the %s mark', (type) => {
    render(<MediaServerIcon type={type} />);

    expect(screen.getByRole('img', { name: `${type} server` })).toHaveAttribute(
      'src',
      expect.stringMatching(new RegExp(`images/servers/${type}\\.png$`))
    );
  });
});
