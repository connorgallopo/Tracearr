import { describe, it, expect } from 'vitest';
import { SETTINGS_HOME, findSettingsSection, settingsNav } from './settings-nav-data';

describe('settings nav data', () => {
  it('gives every section a unique href under /settings', () => {
    const hrefs = settingsNav.flatMap((group) => group.sections.map((section) => section.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs.every((href) => href.startsWith('/settings/'))).toBe(true);
  });

  it('points the home path at the first visible section', () => {
    expect(SETTINGS_HOME).toBe('/settings/general/appearance');
    expect(settingsNav[0]?.sections[0]?.href).toBe(SETTINGS_HOME);
  });

  it('finds a section and its group from the pathname', () => {
    const found = findSettingsSection('/settings/access/mobile');

    expect(found?.group.labelKey).toBe('nav.groups.access');
    expect(found?.section.nameKey).toBe('nav.sections.mobile');
    expect(found?.section.href).toBe('/settings/access/mobile');
  });

  it('ignores a trailing slash', () => {
    expect(findSettingsSection('/settings/data/jobs/')?.section.href).toBe('/settings/data/jobs');
  });

  it('matches a nested editor path to its section by prefix', () => {
    expect(findSettingsSection('/settings/notifications/newsletters/new')?.section.href).toBe(
      '/settings/notifications/newsletters'
    );
    expect(
      findSettingsSection(
        '/settings/notifications/newsletters/2c7a0b1e-0000-4000-8000-000000000001'
      )?.section.nameKey
    ).toBe('nav.sections.newsletters');
    expect(findSettingsSection('/settings/notifications/newslettersx')).toBeNull();
    expect(findSettingsSection('/settings/nope')).toBeNull();
  });
});
