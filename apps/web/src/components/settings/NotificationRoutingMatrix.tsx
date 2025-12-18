import { Info } from 'lucide-react';
import type { NotificationChannelRouting, NotificationEventType } from '@tracearr/shared';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useChannelRouting, useUpdateChannelRouting } from '@/hooks/queries';

// Display names and descriptions for event types
const EVENT_CONFIG: Record<NotificationEventType, { name: string; description: string }> = {
  violation_detected: {
    name: 'Rule Violation',
    description: 'A user triggered a rule violation (e.g., concurrent streams, impossible travel)',
  },
  new_device: {
    name: 'New Device',
    description: 'A user logged in from a new device for the first time',
  },
  trust_score_changed: {
    name: 'Trust Score Changed',
    description: "A user's trust score changed significantly",
  },
  stream_started: {
    name: 'Stream Started',
    description: 'A user started watching content',
  },
  stream_stopped: {
    name: 'Stream Stopped',
    description: 'A user stopped watching content',
  },
  concurrent_streams: {
    name: 'Concurrent Streams',
    description: 'Multiple streams detected from the same user',
  },
  server_down: {
    name: 'Server Offline',
    description: 'A media server became unreachable',
  },
  server_up: {
    name: 'Server Online',
    description: 'A media server came back online',
  },
};

// Order of events in the table (security first, then streams, then server)
const EVENT_ORDER: NotificationEventType[] = [
  'violation_detected',
  'new_device',
  'trust_score_changed',
  'stream_started',
  'stream_stopped',
  'concurrent_streams',
  'server_down',
  'server_up',
];

interface NotificationRoutingMatrixProps {
  discordConfigured: boolean;
  webhookConfigured: boolean;
}

export function NotificationRoutingMatrix({
  discordConfigured,
  webhookConfigured,
}: NotificationRoutingMatrixProps) {
  const { data: routingData, isLoading } = useChannelRouting();
  const updateRouting = useUpdateChannelRouting();

  // Build a map for quick lookup
  const routingMap = new Map<NotificationEventType, NotificationChannelRouting>();
  routingData?.forEach((r) => routingMap.set(r.eventType, r));

  const handleToggle = (
    eventType: NotificationEventType,
    channel: 'discord' | 'webhook' | 'webToast',
    checked: boolean
  ) => {
    updateRouting.mutate({
      eventType,
      ...(channel === 'discord' && { discordEnabled: checked }),
      ...(channel === 'webhook' && { webhookEnabled: checked }),
      ...(channel === 'webToast' && { webToastEnabled: checked }),
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {EVENT_ORDER.map((eventType) => (
          <Skeleton key={eventType} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Table */}
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="px-4 py-3">Event</TableHead>
                <TableHead className="w-24 px-4 py-3 text-center">Web</TableHead>
                {discordConfigured && (
                  <TableHead className="w-24 px-4 py-3 text-center">Discord</TableHead>
                )}
                {webhookConfigured && (
                  <TableHead className="w-24 px-4 py-3 text-center">Webhook</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {EVENT_ORDER.map((eventType) => {
                const routing = routingMap.get(eventType);
                const config = EVENT_CONFIG[eventType];

                return (
                  <TableRow key={eventType}>
                    <TableCell className="px-4 py-3">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="border-muted-foreground/50 cursor-help border-b border-dotted text-sm">
                            {config.name}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-xs">
                          <p>{config.description}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell className="px-4 py-3 text-center">
                      <Checkbox
                        checked={routing?.webToastEnabled ?? true}
                        onCheckedChange={(checked) =>
                          handleToggle(eventType, 'webToast', checked === true)
                        }
                        disabled={updateRouting.isPending}
                      />
                    </TableCell>
                    {discordConfigured && (
                      <TableCell className="px-4 py-3 text-center">
                        <Checkbox
                          checked={routing?.discordEnabled ?? false}
                          onCheckedChange={(checked) =>
                            handleToggle(eventType, 'discord', checked === true)
                          }
                          disabled={updateRouting.isPending}
                        />
                      </TableCell>
                    )}
                    {webhookConfigured && (
                      <TableCell className="px-4 py-3 text-center">
                        <Checkbox
                          checked={routing?.webhookEnabled ?? false}
                          onCheckedChange={(checked) =>
                            handleToggle(eventType, 'webhook', checked === true)
                          }
                          disabled={updateRouting.isPending}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {/* Info about notification channels */}
        <div className="text-muted-foreground flex items-start gap-2 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>Web</strong> shows toast notifications in this browser. Push notifications are
            configured per-device in the mobile app.
          </span>
        </div>
      </div>
    </TooltipProvider>
  );
}
