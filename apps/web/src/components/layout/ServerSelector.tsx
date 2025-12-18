import { useServer } from '@/hooks/useServer';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';

export function ServerSelector() {
  const { servers, selectedServerId, selectServer, isLoading, isFetching } = useServer();

  // Show skeleton while loading initially or refetching with no cached data
  if (isLoading || (servers.length === 0 && isFetching)) {
    return (
      <div className="px-4 py-2">
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  // No servers available
  if (servers.length === 0) {
    return null;
  }

  // Only show selector if there are multiple servers
  if (servers.length === 1) {
    const server = servers[0]!;
    return (
      <div className="text-muted-foreground flex items-center gap-2 px-4 py-2 text-sm">
        <MediaServerIcon type={server.type} className="h-4 w-4" />
        <span className="truncate font-medium">{server.name}</span>
      </div>
    );
  }

  return (
    <div className="px-4 py-2">
      <Select value={selectedServerId ?? undefined} onValueChange={selectServer}>
        <SelectTrigger className="h-9 w-full">
          <SelectValue placeholder="Select server" />
        </SelectTrigger>
        <SelectContent>
          {servers.map((server) => (
            <SelectItem key={server.id} value={server.id}>
              <div className="flex items-center gap-2">
                <MediaServerIcon type={server.type} className="h-4 w-4 shrink-0" />
                <span className="truncate">{server.name}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
