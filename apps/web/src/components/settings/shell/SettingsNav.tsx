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
import { findSettingsSection, settingsNav } from './settings-nav-data';

// The app's small-caps label convention (see UpdateDialog.tsx).
const GROUP_LABEL =
  'text-muted-foreground flex h-8 shrink-0 items-center px-2 text-xs font-medium tracking-wide uppercase';

const LINK =
  'ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex h-8 items-center rounded-md px-2 text-sm outline-hidden transition-colors focus-visible:ring-2';

// Where-am-I state: neutral fill plus an accent bar, so the page's own data stays the loudest thing.
const LINK_ACTIVE =
  'bg-sidebar-accent text-sidebar-accent-foreground relative font-medium before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary';

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
              group.sections.map((section) => (
                <SelectItem key={section.href} value={section.href}>
                  {t('nav.itemLabel', {
                    group: t(group.labelKey),
                    section: t(section.nameKey),
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
            <p className={GROUP_LABEL}>{t(group.labelKey)}</p>
            {group.sections.map((section) => (
              <NavLink
                key={section.href}
                to={section.href}
                className={({ isActive }) => cn(LINK, isActive && LINK_ACTIVE)}
              >
                {t(section.nameKey)}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
    </>
  );
}
