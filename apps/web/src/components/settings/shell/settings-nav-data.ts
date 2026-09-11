import type { ParseKeys } from 'i18next';

export interface SettingsSectionItem {
  nameKey: ParseKeys<'settings'>;
  href: string;
}

export interface SettingsGroup {
  labelKey: ParseKeys<'settings'>;
  sections: SettingsSectionItem[];
}

export const SETTINGS_HOME = '/settings/general/appearance';

/** The one settings surface with a real grid; Settings.tsx widens its content column for it. */
export const BACKUP_HREF = '/settings/data/backup';

export const settingsNav: SettingsGroup[] = [
  {
    labelKey: 'nav.groups.general',
    sections: [
      { nameKey: 'nav.sections.appearance', href: '/settings/general/appearance' },
      { nameKey: 'nav.sections.locale', href: '/settings/general/locale' },
      { nameKey: 'nav.sections.behavior', href: '/settings/general/behavior' },
    ],
  },
  {
    labelKey: 'nav.groups.servers',
    sections: [
      { nameKey: 'nav.sections.connections', href: '/settings/servers/connections' },
      { nameKey: 'nav.sections.posters', href: '/settings/servers/posters' },
      { nameKey: 'nav.sections.plexAccounts', href: '/settings/servers/plex-accounts' },
    ],
  },
  {
    labelKey: 'nav.groups.notifications',
    sections: [
      { nameKey: 'nav.sections.destinations', href: '/settings/notifications/destinations' },
      { nameKey: 'nav.sections.newsletters', href: '/settings/notifications/newsletters' },
      { nameKey: 'nav.sections.email', href: '/settings/notifications/email' },
    ],
  },
  {
    labelKey: 'nav.groups.access',
    sections: [
      { nameKey: 'nav.sections.guest', href: '/settings/access/guest' },
      { nameKey: 'nav.sections.mobile', href: '/settings/access/mobile' },
      { nameKey: 'nav.sections.remote', href: '/settings/access/remote' },
    ],
  },
  {
    labelKey: 'nav.groups.data',
    sections: [
      { nameKey: 'nav.sections.import', href: '/settings/data/import' },
      { nameKey: 'nav.sections.backup', href: BACKUP_HREF },
      { nameKey: 'nav.sections.jobs', href: '/settings/data/jobs' },
      { nameKey: 'nav.sections.api', href: '/settings/data/api' },
    ],
  },
];

/** A nested route such as the newsletter editor highlights the section it sits under; the longest matching href wins. */
export function findSettingsSection(
  pathname: string
): { group: SettingsGroup; section: SettingsSectionItem } | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  let best: { group: SettingsGroup; section: SettingsSectionItem } | null = null;

  for (const group of settingsNav) {
    for (const section of group.sections) {
      const matches = normalized === section.href || normalized.startsWith(`${section.href}/`);
      if (matches && (best === null || section.href.length > best.section.href.length)) {
        best = { group, section };
      }
    }
  }

  return best;
}
