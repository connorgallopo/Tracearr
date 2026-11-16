import { createContext, useContext, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light' | 'system';

// Default accent hue (cyan = 187)
const DEFAULT_ACCENT_HUE = 187;

// Accent presets. `hue` is the HSL hue stored in localStorage (and used by the
// maps); okHue and the two chromas feed the OKLCH primary in globals.css, where
// lightness is fixed per mode. Each chroma is the largest that stays in sRGB at
// that lightness, which keeps text on primary at 5.4:1 or better for every preset.
export const ACCENT_PRESETS = [
  { name: 'Cyan', hue: 187, okHue: 212, chromaLight: 0.085, chromaDark: 0.128 },
  { name: 'Blue', hue: 220, okHue: 260, chromaLight: 0.19, chromaDark: 0.126 },
  { name: 'Purple', hue: 270, okHue: 293, chromaLight: 0.19, chromaDark: 0.139 },
  { name: 'Pink', hue: 330, okHue: 354, chromaLight: 0.19, chromaDark: 0.17 },
  { name: 'Red', hue: 0, okHue: 25, chromaLight: 0.19, chromaDark: 0.148 },
  { name: 'Orange', hue: 24, okHue: 45, chromaLight: 0.14, chromaDark: 0.157 },
  { name: 'Green', hue: 150, okHue: 150, chromaLight: 0.135, chromaDark: 0.17 },
  { name: 'Teal', hue: 175, okHue: 183, chromaLight: 0.087, chromaDark: 0.131 },
] as const;

type AccentPreset = (typeof ACCENT_PRESETS)[number];

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/** A stored hue outside the presets takes the nearest preset's OKLCH values. */
export function accentPreset(hue: number): AccentPreset {
  return ACCENT_PRESETS.reduce((best, preset) =>
    hueDistance(preset.hue, hue) < hueDistance(best.hue, hue) ? preset : best
  );
}

export function accentVars(preset: AccentPreset): Record<string, string> {
  return {
    '--accent-h': String(preset.okHue),
    '--accent-cl': String(preset.chromaLight),
    '--accent-cd': String(preset.chromaDark),
  };
}

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
  accentStorageKey?: string;
}

interface ThemeProviderState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  accentHue: number;
  setAccentHue: (hue: number) => void;
}

const initialState: ThemeProviderState = {
  theme: 'system',
  setTheme: () => null,
  accentHue: DEFAULT_ACCENT_HUE,
  setAccentHue: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

export function ThemeProvider({
  children,
  defaultTheme = 'dark',
  storageKey = 'tracearr-theme',
  accentStorageKey = 'tracearr-accent-hue',
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme) || defaultTheme
  );

  const [accentHue, setAccentHueState] = useState<number>(() => {
    const stored = localStorage.getItem(accentStorageKey);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed < 360) {
        return parsed;
      }
    }
    return DEFAULT_ACCENT_HUE;
  });

  // Apply theme class to root element
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
      root.classList.add(systemTheme);
      return;
    }

    root.classList.add(theme);
  }, [theme]);

  // Apply accent hue CSS variable to root element
  useEffect(() => {
    const root = window.document.documentElement;
    root.style.setProperty('--accent-hue', String(accentHue));
    for (const [name, value] of Object.entries(accentVars(accentPreset(accentHue)))) {
      root.style.setProperty(name, value);
    }
  }, [accentHue]);

  const value = {
    theme,
    setTheme: (theme: Theme) => {
      localStorage.setItem(storageKey, theme);
      setTheme(theme);
    },
    accentHue,
    setAccentHue: (hue: number) => {
      // Normalize hue to 0-359 range
      const normalizedHue = ((hue % 360) + 360) % 360;
      localStorage.setItem(accentStorageKey, String(normalizedHue));
      setAccentHueState(normalizedHue);
    },
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);
  if (context === undefined) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
};
