import type { ParseKeys } from 'i18next';

export interface SettingsSectionItem {
  nameKey: ParseKeys<'settings'>;
  href: string;
  hidden?: boolean;
}

export interface SettingsGroup {
  labelKey: ParseKeys<'settings'>;
  sections: SettingsSectionItem[];
}

export const SETTINGS_HOME = '/settings/general/appearance';

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
      {
        nameKey: 'nav.sections.newsletters',
        href: '/settings/notifications/newsletters',
        hidden: true,
      },
      { nameKey: 'nav.sections.email', href: '/settings/notifications/email', hidden: true },
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
      { nameKey: 'nav.sections.backup', href: '/settings/data/backup' },
      { nameKey: 'nav.sections.jobs', href: '/settings/data/jobs' },
      { nameKey: 'nav.sections.api', href: '/settings/data/api' },
    ],
  },
];

/** Hidden sections have no route until stage 4, so nothing can be active at their href. */
export function findSettingsSection(
  pathname: string
): { group: SettingsGroup; section: SettingsSectionItem } | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

  for (const group of settingsNav) {
    for (const section of group.sections) {
      if (!section.hidden && section.href === normalized) {
        return { group, section };
      }
    }
  }

  return null;
}
