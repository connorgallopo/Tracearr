import { NavLink, useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  findSettingsSection,
  settingsNav,
  type SettingsGroup,
  type SettingsSectionItem,
} from './settings-nav-data';

// SidebarGroupLabel's own classes, applied to a plain element: it needs no
// SidebarProvider, and the --sidebar-* tokens are declared on :root.
const GROUP_LABEL =
  'text-sidebar-foreground/70 flex h-8 shrink-0 items-center px-2 text-xs font-medium';

const LINK =
  'ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex h-8 items-center rounded-md px-2 text-sm outline-hidden transition-colors focus-visible:ring-2';

const LINK_ACTIVE = 'bg-sidebar-primary text-sidebar-primary-foreground font-medium';

function visibleSections(group: SettingsGroup): SettingsSectionItem[] {
  return group.sections.filter((section) => !section.hidden);
}

export function SettingsNav(): React.JSX.Element {
  const { t } = useTranslation('settings');
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const active = findSettingsSection(pathname);

  return (
    <>
      <div data-testid="settings-nav-select" className="@3xl/settings:hidden">
        <Select
          value={active?.section.href ?? ''}
          onValueChange={(href) => {
            void navigate(href);
          }}
        >
          <SelectTrigger className="w-full" aria-label={t('nav.selectLabel')}>
            <SelectValue placeholder={t('nav.selectLabel')} />
          </SelectTrigger>
          <SelectContent>
            {settingsNav.flatMap((group) =>
              visibleSections(group).map((section) => (
                <SelectItem key={section.href} value={section.href}>
                  {t('nav.itemLabel', {
                    group: t(group.labelKey, { defaultValue: group.labelKey }),
                    section: t(section.nameKey, { defaultValue: section.nameKey }),
                  })}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>

      <nav aria-label={t('nav.label')} className="hidden w-52 space-y-4 @3xl/settings:block">
        {settingsNav.map((group) => (
          <div key={group.labelKey} className="space-y-0.5">
            <p className={GROUP_LABEL}>{t(group.labelKey, { defaultValue: group.labelKey })}</p>
            {visibleSections(group).map((section) => (
              <NavLink
                key={section.href}
                to={section.href}
                className={({ isActive }) => cn(LINK, isActive && LINK_ACTIVE)}
              >
                {t(section.nameKey, { defaultValue: section.nameKey })}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
    </>
  );
}
