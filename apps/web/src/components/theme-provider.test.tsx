import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeProvider } from './theme-provider';

describe('ThemeProvider accent', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('style');
  });

  it('gives a stored hue outside the presets the nearest preset', () => {
    // 100 is nearest Green (HSL 150), whose OKLCH hue is 150.
    localStorage.setItem('tracearr-accent-hue', '100');
    render(<ThemeProvider>{null}</ThemeProvider>);

    const root = document.documentElement.style;
    expect(root.getPropertyValue('--accent-hue')).toBe('100');
    expect(root.getPropertyValue('--accent-h')).toBe('150');
    expect(root.getPropertyValue('--accent-cl')).toBe('0.135');
  });
});
