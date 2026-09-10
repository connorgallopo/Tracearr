import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_EMAIL_BRANDING } from '@tracearr/shared';

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
vi.mock('../../settings.js', () => ({
  getSetting: (...a: unknown[]) => mockGetSetting(...a) as unknown,
  setSetting: (...a: unknown[]) => mockSetSetting(...a) as unknown,
}));
const mockWarn = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() }),
}));

import { getEmailBranding, resolveEmailBranding, saveEmailBranding } from '../emailBranding.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockSetSetting.mockResolvedValue(undefined);
});

describe('getEmailBranding', () => {
  it('reads the emailBranding key and returns the defaults when nothing is stored', async () => {
    mockGetSetting.mockResolvedValue(null);
    expect(await getEmailBranding()).toEqual(DEFAULT_EMAIL_BRANDING);
    expect(mockGetSetting).toHaveBeenCalledWith('emailBranding');
  });

  it('fills missing fields of a partial stored block', async () => {
    mockGetSetting.mockResolvedValue({ accentColor: '#123456' });
    expect(await getEmailBranding()).toEqual({ ...DEFAULT_EMAIL_BRANDING, accentColor: '#123456' });
  });

  it('falls back to the defaults when the stored block fails the schema', async () => {
    mockGetSetting.mockResolvedValue({ accentColor: 'teal', bogus: 1 });
    expect(await getEmailBranding()).toEqual(DEFAULT_EMAIL_BRANDING);
    expect(mockWarn).toHaveBeenCalledWith(
      'Stored email branding failed validation; using defaults',
      { issue: 'accentColor: Expected a hex color like #0ea0b3' }
    );
  });

  it('strips keys this build does not know instead of resetting the block', async () => {
    mockGetSetting.mockResolvedValue({ senderName: 'Movies', accentColor: '#123456' });
    expect(await getEmailBranding()).toEqual({ ...DEFAULT_EMAIL_BRANDING, accentColor: '#123456' });
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

describe('saveEmailBranding', () => {
  it('writes the block under emailBranding and returns it', async () => {
    const input = { ...DEFAULT_EMAIL_BRANDING, footerText: 'Movies', mailtoUnsubscribe: true };
    expect(await saveEmailBranding(input)).toEqual(input);
    expect(mockSetSetting).toHaveBeenCalledWith('emailBranding', input);
  });
});

describe('resolveEmailBranding', () => {
  it('returns the block without a sender name, with the logo and mailto settings beside it', async () => {
    mockGetSetting.mockResolvedValue(null);
    expect(await resolveEmailBranding()).toEqual({
      branding: { accentColor: '#0ea0b3', footerText: null, postalAddress: null },
      logo: { mode: 'tracearr' },
      mailtoUnsubscribe: false,
    });
  });

  it('carries every stored field', async () => {
    mockGetSetting.mockResolvedValue({
      logo: { mode: 'url', url: 'https://x.test/logo.png' },
      accentColor: '#123456',
      footerText: 'see you next week',
      postalAddress: '1 Main St',
      mailtoUnsubscribe: true,
    });
    expect(await resolveEmailBranding()).toEqual({
      branding: {
        accentColor: '#123456',
        footerText: 'see you next week',
        postalAddress: '1 Main St',
      },
      logo: { mode: 'url', url: 'https://x.test/logo.png' },
      mailtoUnsubscribe: true,
    });
  });
});
