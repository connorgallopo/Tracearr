import type { CSSProperties } from 'react';
import type { EmailBranding } from './types.js';

/** The web app's light-mode primary, hsl(187 85% 38%), as hex. */
export const DEFAULT_ACCENT = '#0ea0b3';

export const colors = {
  page: '#0f1115',
  card: '#1a1d23',
  raised: '#23272f',
  border: '#2a2e36',
  edge: '#343945',
  text: '#e6e8eb',
  soft: '#c7cdd6',
  muted: '#9aa3ad',
  low: '#3498db',
  warning: '#f39c12',
  high: '#e74c3c',
} as const;

export const font = "'Open Sans', Helvetica, Arial, sans-serif";

export function defaultBranding(senderName: string): EmailBranding {
  return { senderName, accentColor: DEFAULT_ACCENT, footerText: null, postalAddress: null };
}

export const body: CSSProperties = {
  margin: 0,
  padding: 0,
  backgroundColor: colors.page,
  color: colors.text,
  fontFamily: font,
  fontSize: '14px',
  lineHeight: '1.5',
};

export const frame: CSSProperties = { maxWidth: '600px', margin: '0 auto' };

/** Outlook.com can drop body styles; the frame cell restates the font so nothing falls back to Times. */
export const framePadding: CSSProperties = { padding: '24px 16px 32px', fontFamily: font };

export const card: CSSProperties = {
  backgroundColor: colors.card,
  color: colors.text,
  border: `1px solid ${colors.border}`,
  borderRadius: '6px',
  padding: '16px',
};

/** Text styles use margin longhands only: react-email's Text keeps a margin shorthand and adds all four longhands beside it, which costs 40-odd bytes per paragraph. */
export const muted: CSSProperties = {
  color: colors.muted,
  fontSize: '12px',
  marginTop: 0,
  marginBottom: 0,
};

export const paragraph: CSSProperties = {
  color: colors.text,
  fontSize: '14px',
  marginTop: 0,
  marginBottom: '12px',
};

export function heading(accent: string): CSSProperties {
  return { color: accent, fontSize: '20px', fontWeight: 600, marginTop: 0, marginBottom: '8px' };
}

export function link(accent: string): CSSProperties {
  return { color: accent, textDecoration: 'underline' };
}
