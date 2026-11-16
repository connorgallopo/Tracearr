import { useTranslation } from 'react-i18next';
import {
  BookOpen,
  ChevronsUpDown,
  Eye,
  Globe,
  Heart,
  LogOut,
  Monitor,
  Moon,
  Sun,
} from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useAuth } from '@/hooks/useAuth';
import { useTheme } from '@/components/theme-provider';

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

const externalLinks = [
  { name: 'Discord', href: 'https://discord.gg/a7n3sFd2Yw', icon: DiscordIcon },
  { name: 'Docs', href: 'https://docs.tracearr.com/', icon: BookOpen },
  { name: 'Website', href: 'https://tracearr.com', icon: Globe },
  { name: 'GitHub', href: 'https://github.com/connorgallopo/Tracearr', icon: GithubIcon },
  { name: 'Sponsor', href: 'https://github.com/sponsors/connorgallopo', icon: Heart },
];

export function NavUser() {
  const { t } = useTranslation(['common', 'settings', 'pages']);
  const { user, logout } = useAuth();
  const { isMobile } = useSidebar();
  const { theme, setTheme } = useTheme();

  if (!user) return null;

  // A preview that cannot be stopped says so; the owner stays signed in
  const handleLogout = () => {
    logout().catch((error: unknown) => {
      toast.error(t('common:errors.generic'), {
        description: error instanceof Error ? error.message : undefined,
      });
    });
  };

  const displayName = user.name ?? user.username;
  const initials = displayName.slice(0, 2).toUpperCase();
  const ThemeIcon = THEME_ICONS[theme];

  // The rail is narrow, so the footer button carries the name alone; the
  // address still identifies the account inside the roomier dropdown.
  const identity = (withEmail: boolean) => (
    <>
      <Avatar className="size-8 rounded-lg">
        {user.thumbUrl && <AvatarImage src={user.thumbUrl} alt={displayName} />}
        <AvatarFallback className="bg-primary/10 text-primary rounded-lg text-xs">
          {initials}
        </AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{displayName}</span>
        {withEmail && user.email && (
          <span className="text-muted-foreground truncate text-xs">{user.email}</span>
        )}
      </div>
    </>
  );

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="lg"
            variant="outline"
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          >
            {identity(false)}
            <ChevronsUpDown className="ml-auto size-4" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          // The trigger narrowed with the sidebar; the address is the reason
          // this menu shows an identity block, so give it room to sit unclipped.
          className="w-(--radix-dropdown-menu-trigger-width) min-w-64 rounded-lg"
          side={isMobile ? 'bottom' : 'right'}
          align="end"
          sideOffset={4}
        >
          <DropdownMenuLabel className="p-0 font-normal">
            <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
              {identity(true)}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ThemeIcon />
              {t('settings:general.theme')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={theme}
                onValueChange={(next) => setTheme(next as 'light' | 'dark' | 'system')}
              >
                <DropdownMenuRadioItem value="light">
                  {t('settings:general.themeLight')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">
                  {t('settings:general.themeDark')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system">
                  {t('settings:general.themeSystem')}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            {externalLinks.map((link) => (
              <DropdownMenuItem key={link.name} asChild>
                <a href={link.href} target="_blank" rel="noopener noreferrer">
                  <link.icon className="size-4" />
                  {link.name}
                </a>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleLogout} variant="destructive">
            {user.impersonatedBy ? <Eye /> : <LogOut />}
            {user.impersonatedBy
              ? t('pages:impersonation.stopViewing')
              : t('common:actions.signOut')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}
