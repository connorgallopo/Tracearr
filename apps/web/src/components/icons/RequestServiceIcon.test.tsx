import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RequestServiceIcon } from './RequestServiceIcon';
import { mediaServerIconPath } from './MediaServerIcon';

describe('RequestServiceIcon', () => {
  it("shows the server's own logo for a server's requests and Seerr's for Seerr", () => {
    const { container, rerender } = render(<RequestServiceIcon type="server" serverType="tofa" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(mediaServerIconPath('tofa'));
    rerender(<RequestServiceIcon type="seerr" serverType="plex" />);
    expect(container.querySelector('img')?.getAttribute('src')).toMatch(
      /images\/services\/seerr\.svg$/
    );
  });
});
