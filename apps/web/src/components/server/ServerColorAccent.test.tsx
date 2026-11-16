import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ServerColorAccent } from './ServerColorAccent';

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));
vi.mock('@/hooks/useServerColorMap', () => ({
  useServerColorMap: vi.fn(),
}));

import { useServer } from '@/hooks/useServer';
import { useServerColorMap } from '@/hooks/useServerColorMap';

const mockUseServer = vi.mocked(useServer);
const mockColorMap = vi.mocked(useServerColorMap);

beforeEach(() => {
  mockUseServer.mockReset();
  mockColorMap.mockReset();
});

describe('ServerColorAccent', () => {
  it('applies inset boxShadow with the server color when multi-server', () => {
    mockUseServer.mockReturnValue({ isMultiServer: true } as ReturnType<typeof useServer>);
    mockColorMap.mockReturnValue(new Map([['srv-a', '#E5A00D']]));

    render(
      <ServerColorAccent serverId="srv-a">
        <div data-testid="child">x</div>
      </ServerColorAccent>
    );

    const wrapper = screen.getByTestId('child').parentElement!;
    expect(wrapper.style.boxShadow).toContain('inset');
    expect(wrapper.style.boxShadow).toContain('rgb(229, 160, 13)');
  });

  it('renders no boxShadow when not multi-server', () => {
    mockUseServer.mockReturnValue({ isMultiServer: false } as ReturnType<typeof useServer>);
    mockColorMap.mockReturnValue(new Map([['srv-a', '#E5A00D']]));

    render(
      <ServerColorAccent serverId="srv-a">
        <div data-testid="child">x</div>
      </ServerColorAccent>
    );

    const wrapper = screen.getByTestId('child').parentElement!;
    expect(wrapper.style.boxShadow).toBe('');
  });

  it('renders no boxShadow when the serverId has no color in the map', () => {
    mockUseServer.mockReturnValue({ isMultiServer: true } as ReturnType<typeof useServer>);
    mockColorMap.mockReturnValue(new Map([['srv-a', null]]));

    render(
      <ServerColorAccent serverId="srv-a">
        <div data-testid="child">x</div>
      </ServerColorAccent>
    );

    const wrapper = screen.getByTestId('child').parentElement!;
    expect(wrapper.style.boxShadow).toBe('');
  });

  it('passes through className and remaining props to the wrapper', () => {
    mockUseServer.mockReturnValue({ isMultiServer: false } as ReturnType<typeof useServer>);
    mockColorMap.mockReturnValue(new Map());

    render(
      <ServerColorAccent serverId="srv-a" className="my-class">
        <div data-testid="child">x</div>
      </ServerColorAccent>
    );

    const wrapper = screen.getByTestId('child').parentElement!;
    expect(wrapper.className).toContain('my-class');
  });

  it('forwards onClick to the wrapper element', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    mockUseServer.mockReturnValue({ isMultiServer: false } as ReturnType<typeof useServer>);
    mockColorMap.mockReturnValue(new Map());

    const handleClick = vi.fn();
    render(
      <ServerColorAccent serverId="srv-a" onClick={handleClick}>
        <div data-testid="child">x</div>
      </ServerColorAccent>
    );

    await user.click(screen.getByTestId('child'));
    expect(handleClick).toHaveBeenCalledOnce();
  });
});
