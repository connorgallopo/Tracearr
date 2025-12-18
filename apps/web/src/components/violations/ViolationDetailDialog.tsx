import { formatDistanceToNow, format } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SeverityBadge } from '@/components/violations/SeverityBadge';
import { getAvatarUrl } from '@/components/users/utils';
import { getViolationDescription, getViolationDetails } from '@/utils/violationDescription';
import { useSettings } from '@/hooks/queries';
import type { ViolationWithDetails } from '@tracearr/shared';
import {
  User,
  AlertTriangle,
  Check,
  X,
  MapPin,
  Users,
  Zap,
  Shield,
  Globe,
  Clock,
  Film,
  Monitor,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { Separator } from '@/components/ui/separator';

const ruleIcons: Record<string, React.ReactNode> = {
  impossible_travel: <MapPin className="h-4 w-4" />,
  simultaneous_locations: <Users className="h-4 w-4" />,
  device_velocity: <Zap className="h-4 w-4" />,
  concurrent_streams: <Shield className="h-4 w-4" />,
  geo_restriction: <Globe className="h-4 w-4" />,
};

interface ViolationDetailDialogProps {
  violation: ViolationWithDetails | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAcknowledge: (id: string) => void;
  onDismiss: (id: string) => void;
  isAcknowledging?: boolean;
  isDismissing?: boolean;
}

export function ViolationDetailDialog({
  violation,
  open,
  onOpenChange,
  onAcknowledge,
  onDismiss,
  isAcknowledging = false,
  isDismissing = false,
}: ViolationDetailDialogProps) {
  const { data: settings } = useSettings();
  const unitSystem = settings?.unitSystem ?? 'metric';

  if (!violation) return null;

  const avatarUrl = getAvatarUrl(violation.user.serverId, violation.user.thumbUrl, 80);
  const description = getViolationDescription(violation, unitSystem);
  const details = getViolationDetails(violation, unitSystem);
  const ruleIcon = ruleIcons[violation.rule.type] ?? <AlertTriangle className="h-4 w-4" />;
  const isPending = !violation.acknowledgedAt;

  // Helper function to check if a value has been seen before
  const isValueSeenBefore = (value: string | null | undefined, history: string[]): boolean => {
    if (!value) return false;
    return history.includes(value);
  };

  // Helper function to check if location has been seen before
  const isLocationSeenBefore = (
    city: string | null,
    country: string | null,
    history: Array<{ city: string | null; country: string | null; ip: string }>
  ): boolean => {
    if (!city && !country) return false;
    return history.some((loc) => loc.city === city && loc.country === country);
  };

  // Collect all sessions for comparison
  // Include triggering session first, then related sessions (excluding duplicates)
  const allSessions: NonNullable<typeof violation.session>[] = (() => {
    const sessions: NonNullable<typeof violation.session>[] = [];
    const seenIds = new Set<string>();

    // Add triggering session first if it exists
    if (violation.session) {
      sessions.push(violation.session);
      seenIds.add(violation.session.id);
    }

    // Add related sessions, excluding the triggering session if it appears
    if (violation.relatedSessions) {
      for (const session of violation.relatedSessions) {
        if (!seenIds.has(session.id)) {
          sessions.push(session);
          seenIds.add(session.id);
        }
      }
    }

    return sessions;
  })();

  // Analyze for suspicious patterns
  const analysis =
    allSessions.length > 1
      ? {
          uniqueIPs: new Set(allSessions.map((s) => s.ipAddress)).size,
          uniqueDevices: new Set(
            allSessions.map((s) => s.deviceId || s.device).filter((d): d is string => !!d)
          ).size,
          uniqueLocations: new Set(
            allSessions
              .map((s) => `${s.geoCity || ''}-${s.geoCountry || ''}`)
              .filter((l) => l !== '-')
          ).size,
          newIPs: allSessions.filter(
            (s) => !isValueSeenBefore(s.ipAddress, violation.userHistory?.previousIPs || [])
          ).length,
          newDevices: allSessions.filter(
            (s) =>
              !isValueSeenBefore(
                s.deviceId || s.device,
                violation.userHistory?.previousDevices || []
              )
          ).length,
          newLocations: allSessions.filter(
            (s) =>
              !isLocationSeenBefore(
                s.geoCity,
                s.geoCountry,
                violation.userHistory?.previousLocations || []
              )
          ).length,
        }
      : null;

  const handleAcknowledge = () => {
    onAcknowledge(violation.id);
    onOpenChange(false);
  };

  const handleDismiss = () => {
    onDismiss(violation.id);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Violation Details</DialogTitle>
          <DialogDescription>Detailed information about this rule violation</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* User Information */}
          <div className="flex items-center gap-4">
            <div className="bg-muted flex h-16 w-16 shrink-0 items-center justify-center rounded-full">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={violation.user.identityName ?? violation.user.username}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                <User className="text-muted-foreground h-8 w-8" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-lg font-semibold">
                {violation.user.identityName ?? violation.user.username}
              </h3>
              <p className="text-muted-foreground truncate text-sm">
                @{violation.user.username}
                {violation.server?.name && ` • ${violation.server.name}`}
              </p>
            </div>
            <SeverityBadge severity={violation.severity} />
          </div>

          <Separator />

          {/* Rule Information */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="bg-muted flex h-8 w-8 items-center justify-center rounded">
                {ruleIcon}
              </div>
              <div>
                <p className="font-medium">{violation.rule.name}</p>
                <p className="text-muted-foreground text-xs capitalize">
                  {violation.rule.type.replace(/_/g, ' ')}
                </p>
              </div>
            </div>
          </div>

          <Separator />

          {/* Violation Description */}
          <div className="space-y-2">
            <h4 className="text-muted-foreground text-sm font-medium">Description</h4>
            <p className="text-sm">{description}</p>
          </div>

          {/* Stream Comparison - Side by side analysis */}
          {allSessions.length > 0 && (
            <>
              <Separator />
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-muted-foreground flex items-center gap-2 text-sm font-medium">
                    <Film className="h-4 w-4" />
                    Stream Comparison
                    {allSessions.length > 1 && (
                      <span className="bg-muted rounded px-2 py-0.5 text-xs">
                        {allSessions.length} streams
                      </span>
                    )}
                  </h4>
                  {analysis && (
                    <div className="flex items-center gap-2 text-xs">
                      {analysis.uniqueIPs > 1 && (
                        <span className="rounded bg-yellow-500/20 px-2 py-0.5 text-yellow-600">
                          {analysis.uniqueIPs} IPs
                        </span>
                      )}
                      {analysis.uniqueDevices > 1 && (
                        <span className="rounded bg-orange-500/20 px-2 py-0.5 text-orange-600">
                          {analysis.uniqueDevices} Devices
                        </span>
                      )}
                      {analysis.uniqueLocations > 1 && (
                        <span className="rounded bg-red-500/20 px-2 py-0.5 text-red-600">
                          {analysis.uniqueLocations} Locations
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Comparison Table */}
                <div className="overflow-x-auto">
                  <div className="min-w-full space-y-2">
                    {allSessions.map((session, idx) => {
                      const isNewIP = !isValueSeenBefore(
                        session.ipAddress,
                        violation.userHistory?.previousIPs || []
                      );
                      const isNewDevice = !isValueSeenBefore(
                        session.deviceId || session.device,
                        violation.userHistory?.previousDevices || []
                      );
                      const isNewLocation = !isLocationSeenBefore(
                        session.geoCity,
                        session.geoCountry,
                        violation.userHistory?.previousLocations || []
                      );
                      const isTriggering = idx === 0 && violation.session?.id === session.id;

                      return (
                        <div
                          key={session.id}
                          className={`rounded-lg border p-3 ${
                            isTriggering ? 'bg-muted/30 border-primary/50' : 'bg-background'
                          }`}
                        >
                          <div className="mb-3 flex items-start justify-between">
                            <div className="min-w-0 flex-1">
                              <div className="mb-1 flex items-center gap-2">
                                <p className="text-muted-foreground text-xs font-medium">
                                  {isTriggering ? 'Triggering Stream' : `Stream #${idx + 1}`}
                                </p>
                                {isTriggering && (
                                  <span className="bg-primary/20 text-primary rounded px-1.5 py-0.5 text-xs">
                                    Primary
                                  </span>
                                )}
                              </div>
                              <p className="truncate text-sm font-medium">
                                {session.mediaTitle}
                                {session.grandparentTitle && (
                                  <span className="text-muted-foreground">
                                    {' '}
                                    • {session.grandparentTitle}
                                  </span>
                                )}
                                {session.seasonNumber && session.episodeNumber && (
                                  <span className="text-muted-foreground">
                                    {' '}
                                    • S{session.seasonNumber}E{session.episodeNumber}
                                  </span>
                                )}
                              </p>
                              <p className="text-muted-foreground text-xs capitalize">
                                {session.mediaType}
                                {session.quality && ` • ${session.quality}`}
                              </p>
                            </div>
                          </div>

                          {/* Comparison Grid */}
                          <div className="grid grid-cols-2 gap-3 text-xs">
                            {/* IP Address */}
                            <div>
                              <div className="mb-1 flex items-center gap-1.5">
                                <p className="text-muted-foreground">IP Address</p>
                                {isNewIP ? (
                                  <AlertCircle className="h-3 w-3 text-yellow-600" />
                                ) : (
                                  <CheckCircle2 className="h-3 w-3 text-green-600" />
                                )}
                              </div>
                              <p className="font-mono font-medium">{session.ipAddress}</p>
                              {isNewIP && (
                                <p className="mt-0.5 text-[10px] text-yellow-600">
                                  ⚠️ First time seen
                                </p>
                              )}
                            </div>

                            {/* Location */}
                            <div>
                              <div className="mb-1 flex items-center gap-1.5">
                                <p className="text-muted-foreground">Location</p>
                                {isNewLocation ? (
                                  <AlertCircle className="h-3 w-3 text-red-600" />
                                ) : (
                                  <CheckCircle2 className="h-3 w-3 text-green-600" />
                                )}
                              </div>
                              <p className="font-medium">
                                {session.geoCity && `${session.geoCity}, `}
                                {session.geoRegion && `${session.geoRegion}, `}
                                {session.geoCountry || 'Unknown'}
                              </p>
                              {isNewLocation && (
                                <p className="mt-0.5 text-[10px] text-red-600">
                                  ⚠️ First time seen
                                </p>
                              )}
                            </div>

                            {/* Device */}
                            <div>
                              <div className="mb-1 flex items-center gap-1.5">
                                <p className="text-muted-foreground">Device</p>
                                {isNewDevice ? (
                                  <AlertCircle className="h-3 w-3 text-orange-600" />
                                ) : (
                                  <CheckCircle2 className="h-3 w-3 text-green-600" />
                                )}
                              </div>
                              <p className="font-medium">
                                {session.device || session.deviceId || 'Unknown'}
                                {session.playerName && ` (${session.playerName})`}
                              </p>
                              {isNewDevice && (
                                <p className="mt-0.5 text-[10px] text-orange-600">
                                  ⚠️ First time seen
                                </p>
                              )}
                            </div>

                            {/* Platform */}
                            <div>
                              <p className="text-muted-foreground mb-1">Platform</p>
                              <p className="font-medium">
                                {session.platform || 'Unknown'}
                                {session.product && ` • ${session.product}`}
                              </p>
                            </div>
                          </div>

                          <p className="text-muted-foreground mt-2 text-xs">
                            Started{' '}
                            {formatDistanceToNow(new Date(session.startedAt), { addSuffix: true })}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Location Information - Only show if comparison view is NOT shown (info is already in comparison view) */}
          {allSessions.length === 0 &&
            violation.session &&
            !violation.relatedSessions?.length &&
            (violation.session.ipAddress ||
              violation.session.geoCity ||
              violation.session.geoCountry) && (
              <>
                <Separator />
                <div className="space-y-3">
                  <h4 className="text-muted-foreground flex items-center gap-2 text-sm font-medium">
                    <MapPin className="h-4 w-4" />
                    Location
                  </h4>
                  <div className="grid grid-cols-2 gap-3">
                    {violation.session.ipAddress && (
                      <div>
                        <p className="text-muted-foreground mb-1 text-xs">IP Address</p>
                        <p className="font-mono text-sm font-medium">
                          {violation.session.ipAddress}
                        </p>
                      </div>
                    )}
                    {(violation.session.geoCity || violation.session.geoCountry) && (
                      <div>
                        <p className="text-muted-foreground mb-1 text-xs">Location</p>
                        <p className="text-sm font-medium">
                          {violation.session.geoCity && `${violation.session.geoCity}, `}
                          {violation.session.geoRegion && `${violation.session.geoRegion}, `}
                          {violation.session.geoCountry || 'Unknown'}
                        </p>
                      </div>
                    )}
                    {violation.session.geoLat && violation.session.geoLon && (
                      <div className="col-span-2">
                        <p className="text-muted-foreground mb-1 text-xs">Coordinates</p>
                        <p className="font-mono text-sm font-medium">
                          {violation.session.geoLat.toFixed(4)},{' '}
                          {violation.session.geoLon.toFixed(4)}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

          {/* Device Information - Only show if comparison view is NOT shown (info is already in comparison view) */}
          {allSessions.length === 0 &&
            violation.session &&
            !violation.relatedSessions?.length &&
            (violation.session.playerName ||
              violation.session.device ||
              violation.session.platform) && (
              <>
                <Separator />
                <div className="space-y-3">
                  <h4 className="text-muted-foreground flex items-center gap-2 text-sm font-medium">
                    <Monitor className="h-4 w-4" />
                    Device & Platform
                  </h4>
                  <div className="grid grid-cols-2 gap-3">
                    {violation.session.playerName && (
                      <div>
                        <p className="text-muted-foreground mb-1 text-xs">Player</p>
                        <p className="text-sm font-medium">{violation.session.playerName}</p>
                      </div>
                    )}
                    {violation.session.device && (
                      <div>
                        <p className="text-muted-foreground mb-1 text-xs">Device</p>
                        <p className="text-sm font-medium">{violation.session.device}</p>
                      </div>
                    )}
                    {violation.session.platform && (
                      <div>
                        <p className="text-muted-foreground mb-1 text-xs">Platform</p>
                        <p className="text-sm font-medium">{violation.session.platform}</p>
                      </div>
                    )}
                    {violation.session.product && (
                      <div>
                        <p className="text-muted-foreground mb-1 text-xs">Product</p>
                        <p className="text-sm font-medium">{violation.session.product}</p>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

          {/* Additional Violation Details */}
          {Object.keys(details).length > 0 && (
            <>
              <Separator />
              <div className="space-y-3">
                <h4 className="text-muted-foreground text-sm font-medium">Violation Details</h4>
                <div className="grid grid-cols-2 gap-3">
                  {Object.entries(details).map(([key, value]) => {
                    // Handle array values (like locations or IP addresses)
                    if (Array.isArray(value)) {
                      return (
                        <div key={key} className="col-span-2">
                          <p className="text-muted-foreground mb-1 text-xs">{key}</p>
                          <div className="flex flex-wrap gap-1">
                            {value.map((item, idx) => (
                              <span
                                key={idx}
                                className="bg-muted inline-flex items-center rounded-md px-2 py-1 text-xs font-medium"
                              >
                                {String(item)}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={key}>
                        <p className="text-muted-foreground mb-1 text-xs">{key}</p>
                        <p className="text-sm font-medium">{String(value)}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* Timestamp */}
          <Separator />
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Clock className="h-4 w-4" />
            <span>
              Created {formatDistanceToNow(new Date(violation.createdAt), { addSuffix: true })}
            </span>
            <span className="mx-2">•</span>
            <span>{format(new Date(violation.createdAt), 'PPpp')}</span>
          </div>

          {violation.acknowledgedAt && (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Check className="h-4 w-4 text-green-600" />
              <span>
                Acknowledged{' '}
                {formatDistanceToNow(new Date(violation.acknowledgedAt), { addSuffix: true })}
              </span>
            </div>
          )}
        </div>

        <DialogFooter className="flex-row justify-end gap-2 sm:justify-end">
          {isPending && (
            <Button variant="default" onClick={handleAcknowledge} disabled={isAcknowledging}>
              <Check className="mr-2 h-4 w-4" />
              {isAcknowledging ? 'Acknowledging...' : 'Acknowledge'}
            </Button>
          )}
          <Button variant="destructive" onClick={handleDismiss} disabled={isDismissing}>
            <X className="mr-2 h-4 w-4" />
            {isDismissing ? 'Dismissing...' : 'Dismiss'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
