import { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowUpCircle } from 'lucide-react';
import { isStaff as staffRole, normalizeVersion } from '@tracearr/shared';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Badge } from '@/components/ui/badge';
import { Logo } from '@/components/brand/Logo';
import { ServerSelector } from './ServerSelector';
import { NavRunningTasks } from './NavRunningTasks';
import { NavUser } from './NavUser';
import {
  navigation,
  footerNavigation,
  isNavItemActive,
  visibleItems,
  type NavItem,
} from './nav-data';
import { UpdateDialog } from './UpdateDialog';
import { WhatsNewDialog } from '@/components/whats-new/WhatsNewDialog';
import { usePendingViolationsCount, useRequestsConfigured, useVersion } from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { useSocket } from '@/hooks/useSocket';
import { withRangeParams } from '@/lib/rangeParams';
import { RELEASE_NOTES, selectReopen, type WhatsNewSections } from '@/lib/releaseNotes';

function PendingViolationsBadge({ enabled }: { enabled: boolean }) {
  const count = usePendingViolationsCount(enabled);
  if (count === 0) return null;

  return (
    <>
      <SidebarMenuBadge className="bg-warning/10 text-warning">{count}</SidebarMenuBadge>
      <span
        data-testid="nav-count-dot"
        className="bg-warning absolute top-1.5 right-1.5 hidden size-1.5 rounded-full group-data-[collapsible=icon]:block"
      />
    </>
  );
}

function NavMenuItem({ item, isStaff }: { item: NavItem; isStaff: boolean }) {
  const { setOpenMobile } = useSidebar();
  const { t } = useTranslation('nav');
  const location = useLocation();
  const isActive = isNavItemActive(location.pathname, item);
  const label = t(item.nameKey);

  return (
    <>
      {item.divider && (
        <li role="none">
          <SidebarSeparator className="my-2" />
        </li>
      )}
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={isActive} tooltip={label}>
          <NavLink
            to={withRangeParams(item.href, location.search)}
            end={item.href === '/'}
            onClick={() => setOpenMobile(false)}
          >
            <item.icon className="size-4" />
            <span>{label}</span>
          </NavLink>
        </SidebarMenuButton>
        {item.badge === 'pendingViolations' && <PendingViolationsBadge enabled={isStaff} />}
      </SidebarMenuItem>
    </>
  );
}

function VersionDisplay({ isStaff }: { isStaff: boolean }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [reopenSections, setReopenSections] = useState<WhatsNewSections | null>(null);
  const { t } = useTranslation(['common', 'settings']);
  const { data: version, isLoading } = useVersion();
  const { serverConnectionStatuses } = useSocket();
  const navigate = useNavigate();

  const runningVersion = version ? normalizeVersion(version.current.version) : null;

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
        <button
          type="button"
          onClick={() => {
            if (runningVersion) setReopenSections(selectReopen(RELEASE_NOTES, runningVersion));
            setNotesOpen(true);
          }}
          title={t('settings:whatsNew.openNotes')}
          aria-label={`${t('settings:whatsNew.openNotes')}: ${displayVersion}`}
          className="ring-sidebar-ring text-muted-foreground hover:text-foreground cursor-pointer text-xs outline-hidden transition-colors focus-visible:ring-2"
        >
          {displayVersion}
          {version.current.isPrerelease && (
            <span className="ml-1">({t('common:beta')})</span>
          )}
        </button>
        {isStaff && version.updateAvailable && version.latest && (
          <Badge
            variant="success"
            className="hover:bg-success/25 h-5 cursor-pointer gap-1"
            onClick={() => setDialogOpen(true)}
          >
            <ArrowUpCircle className="h-3 w-3" />
            <span>{getUpdateLabel()}</span>
          </Badge>
        )}
        {isStaff && pluginUpdateAvailable && (
          <Badge
            variant="warning"
            className="hover:bg-warning/25 h-5 cursor-pointer"
            onClick={() => navigate('/settings/servers/connections')}
            title={t('settings:servers.pluginUpdateAvailable')}
            aria-label={t('settings:servers.pluginUpdateAvailable')}
          >
            <ArrowUpCircle className="h-3 w-3" />
          </Badge>
        )}
      </div>

      {isStaff && version.updateAvailable && version.latest && (
        <UpdateDialog open={dialogOpen} onOpenChange={setDialogOpen} version={version} />
      )}

      {reopenSections && runningVersion && (
        <WhatsNewDialog
          open={notesOpen}
          onOpenChange={setNotesOpen}
          mode="reopen"
          sections={reopenSections}
          runningVersion={runningVersion}
          sinceVersion={null}
          latestVersion={version.latest?.version ?? null}
        />
      )}
    </>
  );
}

export function AppSidebar() {
  const { t } = useTranslation('nav');
  const { state, isMobile } = useSidebar();
  const { user } = useAuth();
  const seerrConfigured = useRequestsConfigured().data?.configured ?? false;
  const role = user?.role ?? 'member';
  // Members cannot read the running tasks, the update check or the connection settings
  const isStaff = staffRole(role);
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
      {/* The rail pins SidebarContent to overflow-hidden at a fixed 48px width
          and unbounded height; restore scrolling so a short window scrolls the
          destinations instead of clipping them. */}
      <SidebarContent className="group-data-[collapsible=icon]:overflow-y-auto">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {visibleItems(navigation, role, seerrConfigured).map((item) => (
                <NavMenuItem key={item.href} item={item} isStaff={isStaff} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        {/* Tasks sit below the nav links and above the account button: the
            footer is bottom-anchored and grows upward, so a task appearing
            moves only the footer's top edge and leaves the account button
            under the pointer where it was. */}
        <SidebarMenu>
          {visibleItems(footerNavigation, role, seerrConfigured).map((item) => (
            <NavMenuItem key={item.href} item={item} isStaff={isStaff} />
          ))}
          {isStaff && <NavRunningTasks />}
          <NavUser />
        </SidebarMenu>
        <VersionDisplay isStaff={isStaff} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
