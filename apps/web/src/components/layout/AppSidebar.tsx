import { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowUpCircle } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Badge } from '@/components/ui/badge';
import { Logo } from '@/components/brand/Logo';
import { ServerSelector } from './ServerSelector';
import { NavRunningTasks } from './NavRunningTasks';
import { NavUser } from './NavUser';
import { navigation, isNavItemActive, type NavItem } from './nav-data';
import { UpdateDialog } from './UpdateDialog';
import { useVersion } from '@/hooks/queries';
import { useSocket } from '@/hooks/useSocket';

function NavMenuItem({ item }: { item: NavItem }) {
  const { setOpenMobile } = useSidebar();
  const { t } = useTranslation('nav');
  const location = useLocation();
  const isActive = isNavItemActive(location.pathname, item);
  const label = t(item.nameKey);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive} tooltip={label}>
        <NavLink to={item.href} end={item.href === '/'} onClick={() => setOpenMobile(false)}>
          <item.icon className="size-4" />
          <span>{label}</span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function VersionDisplay() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { t } = useTranslation(['common', 'settings']);
  const { data: version, isLoading } = useVersion();
  const { serverConnectionStatuses } = useSocket();
  const navigate = useNavigate();

  const pluginUpdateAvailable = [...serverConnectionStatuses.values()].some(
    (s) => s.pluginUpdateAvailable
  );

  if (isLoading || !version) {
    return <div className="text-muted-foreground text-xs">{t('common:states.loading')}</div>;
  }

  const displayVersion = version.current.tag ?? `v${version.current.version}`;

  const getUpdateLabel = () => {
    if (!version.latest) return t('settings:update.title');
    if (version.current.isPrerelease && !version.latest.isPrerelease) {
      return t('settings:update.stableRelease');
    }
    if (version.current.isPrerelease && version.latest.isPrerelease) {
      return t('settings:update.betaUpdate');
    }
    return t('settings:update.title');
  };

  return (
    <>
      <div className="flex items-center justify-center gap-2 group-data-[collapsible=icon]:hidden">
        <span className="text-muted-foreground text-xs">
          {displayVersion}
          {version.current.isPrerelease && (
            <span className="text-muted-foreground/60 ml-1">({t('common:beta')})</span>
          )}
        </span>
        {version.updateAvailable && version.latest && (
          <Badge
            variant="secondary"
            className="h-5 cursor-pointer gap-1 bg-green-500/10 text-green-600 hover:bg-green-500/20 dark:text-green-400"
            onClick={() => setDialogOpen(true)}
          >
            <ArrowUpCircle className="h-3 w-3" />
            <span className="text-[10px]">{getUpdateLabel()}</span>
          </Badge>
        )}
        {pluginUpdateAvailable && (
          <Badge
            variant="secondary"
            className="h-5 cursor-pointer bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"
            onClick={() => navigate('/settings/servers/connections')}
            title={t('settings:servers.pluginUpdateAvailable')}
            aria-label={t('settings:servers.pluginUpdateAvailable')}
          >
            <ArrowUpCircle className="h-3 w-3" />
          </Badge>
        )}
      </div>

      {version.updateAvailable && version.latest && (
        <UpdateDialog open={dialogOpen} onOpenChange={setDialogOpen} version={version} />
      )}
    </>
  );
}

export function AppSidebar() {
  const { t } = useTranslation('nav');
  const { state, isMobile } = useSidebar();
  // The mobile sheet is always full width, so `state` (which tracks the desktop
  // panel) would hide the wordmark inside an open sheet.
  const expanded = isMobile || state === 'expanded';

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b p-0">
        <div className="flex h-14 items-center gap-2 px-4 group-data-[collapsible=icon]:h-auto group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:px-2 group-data-[collapsible=icon]:py-2">
          <Logo size="md" showText={expanded} />
          <SidebarTrigger
            className="ml-auto group-data-[collapsible=icon]:ml-0"
            aria-label={t('toggleSidebar')}
          />
        </div>
        <ServerSelector />
      </SidebarHeader>
      {/* The rail is 48px of fixed width but unbounded height, and shadcn pins
          SidebarContent to overflow-hidden there; 17 destinations overflow a
          768px-tall laptop, so restore scrolling rather than clip them away. */}
      <SidebarContent className="group-data-[collapsible=icon]:overflow-y-auto">
        {navigation.map((section) => (
          <SidebarGroup key={section.labelKey}>
            <SidebarGroupLabel>{t(section.labelKey)}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => (
                  <NavMenuItem key={item.href} item={item} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        {/* Tasks first: the footer is bottom-anchored and grows upward, so a
            task appearing moves only the footer's top edge and leaves the
            account button under the pointer where it was. */}
        <SidebarMenu>
          <NavRunningTasks />
          <NavUser />
        </SidebarMenu>
        <VersionDisplay />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
