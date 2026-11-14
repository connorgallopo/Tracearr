import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2, Clock, CheckCircle2, AlertCircle, Activity } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { useSocket } from '@/hooks/useSocket';
import { api } from '@/lib/api';
import type { RunningTask } from '@tracearr/shared';
import { formatDistanceToNow } from 'date-fns';

function TaskIcon({ status }: { status: RunningTask['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="text-primary h-4 w-4 animate-spin" />;
    case 'waiting':
      return <Clock className="text-muted-foreground h-4 w-4 animate-pulse" />;
    case 'pending':
      return <Clock className="text-muted-foreground h-4 w-4" />;
    case 'complete':
      return <CheckCircle2 className="text-success h-4 w-4" />;
    case 'error':
      return <AlertCircle className="text-destructive h-4 w-4" />;
    default:
      return <Clock className="text-muted-foreground h-4 w-4" />;
  }
}

function TaskItem({ task }: { task: RunningTask }) {
  const { t } = useTranslation('common');
  const timeAgo = formatDistanceToNow(new Date(task.startedAt), { addSuffix: true });

  const statusLabel =
    task.status === 'running'
      ? t('tasks.running')
      : task.status === 'waiting'
        ? t('tasks.waiting')
        : t('tasks.queued');

  return (
    <div className="space-y-2 px-2 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          <TaskIcon status={task.status} />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{task.name}</span>
            <Badge
              variant={task.status === 'running' ? 'default' : 'secondary'}
              className="shrink-0 text-xs"
            >
              {statusLabel}
            </Badge>
          </div>
          {task.context && <p className="text-muted-foreground truncate text-xs">{task.context}</p>}
          <p className="text-muted-foreground text-xs">{task.message}</p>
          {task.progress !== null && task.status === 'running' && (
            <Progress value={task.progress} className="h-1.5" />
          )}
          <p className="text-muted-foreground text-xs">
            {t('tasks.startedAgo', { time: timeAgo })}
          </p>
        </div>
      </div>
    </div>
  );
}

export function NavRunningTasks() {
  const { t } = useTranslation('common');
  const { isConnected } = useSocket();
  const { isMobile } = useSidebar();

  // With the socket connected, job progress events invalidate this cache in
  // SocketProvider; polling backstops queued jobs that have not emitted a
  // progress event yet, so the connected interval stays reasonably tight.
  const { data, isLoading } = useQuery({
    queryKey: ['tasks', 'running'],
    queryFn: () => api.tasks.getRunning(),
    refetchInterval: isConnected ? 15_000 : 10_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });

  const activeTasks = (data?.tasks ?? []).filter(
    (task) => task.status === 'running' || task.status === 'waiting' || task.status === 'pending'
  );

  if (isLoading || activeTasks.length === 0) {
    return null;
  }

  const sections = [
    { key: 'running', label: null, tasks: activeTasks.filter((task) => task.status === 'running') },
    {
      key: 'waiting',
      label: t('tasks.waiting'),
      tasks: activeTasks.filter((task) => task.status === 'waiting'),
    },
    {
      key: 'queued',
      label: t('tasks.queued'),
      tasks: activeTasks.filter((task) => task.status === 'pending'),
    },
  ].filter((section) => section.tasks.length > 0);

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton>
            <Loader2 className="animate-spin" />
            <span>{t('tasks.title')}</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-80"
          side={isMobile ? 'bottom' : 'right'}
          align="end"
          sideOffset={4}
        >
          <DropdownMenuLabel className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            {t('tasks.title')}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {sections.map((section, index) => (
            <div key={section.key}>
              {index > 0 && <DropdownMenuSeparator />}
              {section.label && (
                <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                  {section.label}
                </DropdownMenuLabel>
              )}
              {section.tasks.map((task) => (
                <TaskItem key={task.id} task={task} />
              ))}
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Sibling, not a child: SidebarMenuBadge positions itself with
          peer-data-[size=*]/menu-button selectors, which match nothing from
          inside the button. */}
      <SidebarMenuBadge>{activeTasks.length}</SidebarMenuBadge>
    </SidebarMenuItem>
  );
}
