import { describe, it, expect } from 'vitest';
import { SETTINGS_HOME, findSettingsSection, settingsNav } from './settings-nav-data';

describe('settings nav data', () => {
  it('lists the five groups in order', () => {
    expect(settingsNav.map((group) => group.labelKey)).toEqual([
      'nav.groups.general',
      'nav.groups.servers',
      'nav.groups.notifications',
      'nav.groups.access',
      'nav.groups.data',
    ]);
  });

  it('gives every section a unique href under /settings', () => {
    const hrefs = settingsNav.flatMap((group) => group.sections.map((section) => section.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs.every((href) => href.startsWith('/settings/'))).toBe(true);
  });

  it('points the home path at the first visible section', () => {
    expect(SETTINGS_HOME).toBe('/settings/general/appearance');
    expect(settingsNav[0]?.sections[0]?.href).toBe(SETTINGS_HOME);
  });

  it('carries the two stage 4 sections hidden', () => {
    const hidden = settingsNav
      .flatMap((group) => group.sections)
      .filter((section) => section.hidden)
      .map((section) => section.href);

    expect(hidden).toEqual([
      '/settings/notifications/newsletters',
      '/settings/notifications/email',
    ]);
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

  it('finds nothing for a hidden section or an unknown path', () => {
    expect(findSettingsSection('/settings/notifications/newsletters')).toBeNull();
    expect(findSettingsSection('/settings/nope')).toBeNull();
  });
});
