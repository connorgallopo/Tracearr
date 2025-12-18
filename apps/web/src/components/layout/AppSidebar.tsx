import { NavLink, useLocation } from 'react-router';
import { ChevronRight, ArrowUpCircle, ExternalLink } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { Logo } from '@/components/brand/Logo';
import { ServerSelector } from './ServerSelector';
import { navigation, isNavGroup, type NavItem, type NavGroup } from './nav-data';
import { cn } from '@/lib/utils';
import { useVersion } from '@/hooks/queries';

function NavMenuItem({ item }: { item: NavItem }) {
  const { setOpenMobile } = useSidebar();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild>
        <NavLink
          to={item.href}
          end={item.href === '/'}
          onClick={() => setOpenMobile(false)}
          className={({ isActive }) =>
            cn(isActive && 'bg-sidebar-accent text-sidebar-accent-foreground')
          }
        >
          <item.icon className="size-4" />
          <span>{item.name}</span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function NavMenuGroup({ group }: { group: NavGroup }) {
  const location = useLocation();
  const { setOpenMobile } = useSidebar();
  const isActive = group.children.some((child) => location.pathname.startsWith(child.href));

  return (
    <Collapsible defaultOpen={isActive} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton className={cn(isActive && 'font-medium')}>
            <group.icon className="size-4" />
            <span>{group.name}</span>
            <ChevronRight className="ml-auto size-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {group.children.map((child) => (
              <SidebarMenuSubItem key={child.href}>
                <SidebarMenuSubButton asChild>
                  <NavLink
                    to={child.href}
                    onClick={() => setOpenMobile(false)}
                    className={({ isActive }) =>
                      cn(isActive && 'bg-sidebar-accent text-sidebar-accent-foreground')
                    }
                  >
                    <child.icon className="size-4" />
                    <span>{child.name}</span>
                  </NavLink>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function VersionDisplay() {
  const { data: version, isLoading } = useVersion();

  if (isLoading || !version) {
    return <div className="text-muted-foreground text-xs">Loading...</div>;
  }

  const displayVersion = version.current.tag
    ? `${version.current.tag}`
    : `v${version.current.version}`;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">{displayVersion}</span>
        {version.updateAvailable && version.latest && (
          <Badge
            variant="secondary"
            className="h-5 cursor-pointer gap-1 bg-green-500/10 text-green-600 hover:bg-green-500/20 dark:text-green-400"
            onClick={() => window.open(version.latest!.releaseUrl, '_blank')}
          >
            <ArrowUpCircle className="h-3 w-3" />
            <span className="text-[10px]">Update</span>
          </Badge>
        )}
      </div>
      {version.updateAvailable && version.latest && (
        <a
          href={version.latest.releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[10px] transition-colors"
        >
          <span>{version.latest.tag} available</span>
          <ExternalLink className="h-2.5 w-2.5" />
        </a>
      )}
    </div>
  );
}

export function AppSidebar() {
  return (
    <Sidebar>
      <SidebarHeader className="border-b p-0">
        <div className="flex h-14 items-center px-4">
          <Logo size="md" />
        </div>
        <ServerSelector />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map((entry) => {
                if (isNavGroup(entry)) {
                  return <NavMenuGroup key={entry.name} group={entry} />;
                }
                return <NavMenuItem key={entry.href} item={entry} />;
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t">
        <VersionDisplay />
      </SidebarFooter>
    </Sidebar>
  );
}
