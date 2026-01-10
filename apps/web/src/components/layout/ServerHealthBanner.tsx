import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useSocket } from '@/hooks/useSocket';

/**
 * Banner that displays when one or more servers are unreachable.
 * Updates in real-time via WebSocket events.
 */
export function ServerHealthBanner() {
  const { unhealthyServers } = useSocket();

  if (unhealthyServers.length === 0) {
    return null;
  }

  const serverNames = unhealthyServers.map((s) => s.serverName).join(', ');
  const message =
    unhealthyServers.length === 1
      ? `${serverNames} is unreachable`
      : `${unhealthyServers.length} servers unreachable: ${serverNames}`;

  return (
    <Alert variant="destructive" className="bg-destructive/15 rounded-none border-x-0 border-t-0">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="ml-2">{message}</AlertDescription>
    </Alert>
  );
}
