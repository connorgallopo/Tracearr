import { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'dark' | 'light' | 'system';

// Default accent hue (cyan = 187)
const DEFAULT_ACCENT_HUE = 187;

// Preset accent colors with their hue values
export const ACCENT_PRESETS = [
  { name: 'Cyan', hue: 187, hex: '#18D1E7' },
  { name: 'Blue', hue: 220, hex: '#3B82F6' },
  { name: 'Purple', hue: 270, hex: '#8B5CF6' },
  { name: 'Pink', hue: 330, hex: '#EC4899' },
  { name: 'Red', hue: 0, hex: '#EF4444' },
  { name: 'Orange', hue: 24, hex: '#EA580C' }, // Matches shadcn orange theme
  { name: 'Green', hue: 150, hex: '#22C55E' },
  { name: 'Teal', hue: 175, hex: '#14B8A6' },
] as const;

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
