/**
 * Design system tokens matching Tracearr web app
 * These values match the web's dark mode theme exactly
 */

export const colors = {
  // Brand colors (from Tracearr web)
  cyan: {
    core: '#18D1E7',
    deep: '#0EAFC8',
    dark: '#0A7C96',
  },
  blue: {
    core: '#0B1A2E',
    steel: '#162840',
    soft: '#1E3A5C',
  },

  // Background colors - matching web dark mode
  background: {
    dark: '#050A12',
    light: '#F9FAFB',
  },
  card: {
    dark: '#0B1A2E',
    light: '#FFFFFF',
  },
  surface: {
    dark: '#0F2338',
    light: '#F3F4F6',
  },

  // Accent colors
  orange: {
    core: '#F97316',
  },
  purple: '#8B5CF6',

  // Status colors
  success: '#22C55E',
  warning: '#F59E0B',
  error: '#EF4444',
  danger: '#EF4444',
  info: '#3B82F6',

  // Switch/toggle colors - matching web dark mode border
  switch: {
    trackOff: '#162840',
    trackOn: '#0EAFC8',
    thumbOn: '#18D1E7',
    thumbOff: '#64748B',
  },

  // Text colors - matching web dark mode (CSS: --color-*)
  text: {
    // --color-foreground / --color-card-foreground
    primary: {
      dark: '#FFFFFF',
      light: '#0B1A2E',
    },
    // --color-muted-foreground (used for secondary/muted text)
    secondary: {
      dark: '#94A3B8',
      light: '#64748B',
    },
    // Alias for secondary - use this for muted text in inline styles
    muted: {
      dark: '#94A3B8',
      light: '#64748B',
    },
  },

  // Icon colors - matching web dark mode (CSS: --color-icon-*)
  icon: {
    default: '#8CA3B8',
    active: '#18D1E7',
    danger: '#FF4C4C',
  },

  // Border colors - matching web dark mode (blue-steel)
  border: {
    dark: '#162840',
    light: '#E5E7EB',
  },

  // Chart colors
  chart: ['#18D1E7', '#0EAFC8', '#1E3A5C', '#F59E0B', '#EF4444', '#22C55E'],
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const borderRadius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;

export const typography = {
  fontFamily: {
    regular: 'System',
    medium: 'System',
    bold: 'System',
  },
  fontSize: {
    xs: 12,
    sm: 14,
    base: 16,
    lg: 18,
    xl: 20,
    '2xl': 24,
    '3xl': 30,
    '4xl': 36,
  },
  lineHeight: {
    tight: 1.25,
    normal: 1.5,
    relaxed: 1.75,
  },
} as const;

export const shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 3,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.15,
    shadowRadius: 15,
    elevation: 5,
  },
} as const;

// Helper function to get theme-aware colors
export function getThemeColor(
  colorKey: 'background' | 'card' | 'surface' | 'border',
  isDark: boolean
): string {
  return colors[colorKey][isDark ? 'dark' : 'light'];
}

export function getTextColor(variant: 'primary' | 'secondary' | 'muted', isDark: boolean): string {
  return colors.text[variant][isDark ? 'dark' : 'light'];
}
