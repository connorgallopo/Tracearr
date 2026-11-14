/* eslint-disable @eslint-react/static-components --
 * The icon lookup returns a module-level component, so its reference is stable
 * across renders and nothing remounts. The rule cannot see that through the call.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Monitor,
  Smartphone,
  Tablet,
  Tv,
  ChevronDown,
  ChevronUp,
  Laptop,
  HardDrive,
  MapPin,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { UserDevice } from '@tracearr/shared';
import { formatLocationCompact, getDeviceDisplayName } from '@/lib/utils';
import { LocalBadge } from '@/components/sessions/LocalBadge';

interface UserDevicesCardProps {
  devices: UserDevice[];
  isLoading?: boolean;
  totalSessions?: number;
}

const INITIAL_DISPLAY_COUNT = 5;

function getDeviceIcon(device: UserDevice) {
  const deviceType = device.device?.toLowerCase() ?? '';
  const platform = device.platform?.toLowerCase() ?? '';
  const product = device.product?.toLowerCase() ?? '';

  // Check for TV/streaming devices
  if (
    deviceType.includes('tv') ||
    platform.includes('tv') ||
    product.includes('tv') ||
    product.includes('roku') ||
    product.includes('fire') ||
    product.includes('chromecast') ||
    product.includes('shield')
  ) {
    return Tv;
  }

  // Check for tablets
  if (deviceType.includes('ipad') || deviceType.includes('tablet') || platform.includes('ipad')) {
    return Tablet;
  }

  // Check for phones
  if (
    deviceType.includes('iphone') ||
    deviceType.includes('phone') ||
    deviceType.includes('android') ||
    platform.includes('ios') ||
    platform.includes('android')
  ) {
    return Smartphone;
  }

  // Check for laptops/desktops
  if (
    deviceType.includes('mac') ||
    platform.includes('macos') ||
    platform.includes('windows') ||
    platform.includes('linux')
  ) {
    return Laptop;
  }

  // Check for web browsers
  if (
    product.includes('web') ||
    product.includes('browser') ||
    product.includes('chrome') ||
    product.includes('firefox') ||
    product.includes('safari')
  ) {
    return Monitor;
  }

  // Default
  return HardDrive;
}

function DevicesTitle() {
  const { t } = useTranslation('nav');
  return (
    <div className="flex items-center gap-2">
      <Monitor className="h-5 w-5" />
      {t('devices')}
    </div>
  );
}

export function UserDevicesCard({ devices, isLoading, totalSessions = 0 }: UserDevicesCardProps) {
  const { t } = useTranslation(['pages', 'common']);
  const [isExpanded, setIsExpanded] = useState(false);
  const formatLocationShort = (loc: {
    city: string | null;
    region: string | null;
    country: string | null;
  }) => formatLocationCompact(loc.city, loc.region, loc.country) ?? t('common:labels.unknown');

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <DevicesTitle />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div>
                    <Skeleton className="h-4 w-36" />
                    <Skeleton className="mt-1 h-3 w-24" />
                  </div>
                </div>
                <Skeleton className="h-5 w-12" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (devices.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <DevicesTitle />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">{t('common:empty.noDeviceData')}</p>
        </CardContent>
      </Card>
    );
  }

  const displayedDevices = isExpanded ? devices : devices.slice(0, INITIAL_DISPLAY_COUNT);
  const hasMore = devices.length > INITIAL_DISPLAY_COUNT;

  return (
    <TooltipProvider>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <DevicesTitle />
            <Badge variant="secondary" className="font-normal">
              {t('pages:userDetail.uniqueCount', { count: devices.length })}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {displayedDevices.map((device, index) => {
              const deviceKey = `${device.deviceId ?? index}-${device.playerName ?? ''}-${device.product ?? ''}`;
              const percentage =
                totalSessions > 0 ? Math.round((device.sessionCount / totalSessions) * 100) : 0;
              const DeviceIcon = getDeviceIcon(device);
              const displayName =
                getDeviceDisplayName(device) ?? t('pages:userDetail.unknownDevice');
              const locations = device.locations ?? [];
              const hasMultipleLocations = locations.length > 1;
              const primaryLocation = locations[0];

              return (
                <div
                  key={deviceKey}
                  className="hover:bg-muted/50 flex items-center gap-3 rounded-lg border p-3 transition-colors"
                >
                  {/* Device Icon */}
                  <div className="bg-primary/10 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full">
                    <DeviceIcon className="text-primary h-4 w-4" />
                  </div>

                  {/* Device Info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium">{displayName}</p>
                      {device.platform && (
                        <span className="text-muted-foreground text-xs">{device.platform}</span>
                      )}
                    </div>
                    <div className="text-muted-foreground flex items-center gap-2 text-xs">
                      <span>{t('common:count.session', { count: device.sessionCount })}</span>
                      {device.downloadCount > 0 && (
                        <>
                          <span>·</span>
                          <span>{t('common:count.download', { count: device.downloadCount })}</span>
                        </>
                      )}
                      <span>·</span>
                      <span>
                        {formatDistanceToNow(new Date(device.lastSeenAt), { addSuffix: true })}
                      </span>
                      {primaryLocation && (
                        <>
                          <span>·</span>
                          {hasMultipleLocations ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="text-warning flex cursor-help items-center gap-1">
                                  <MapPin className="h-3 w-3 shrink-0" />
                                  {t('common:count.location', { count: locations.length })}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" className="max-w-xs">
                                <div className="space-y-1">
                                  {locations.map((loc, locIndex) => (
                                    <div
                                      key={locIndex}
                                      className="flex items-center justify-between gap-4 text-xs"
                                    >
                                      <span className="flex items-center gap-1">
                                        {formatLocationShort(loc)}
                                        <LocalBadge isLocal={loc.isLocal} country={loc.country} />
                                      </span>
                                      <span className="text-muted-foreground tabular-nums">
                                        {loc.sessionCount}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="flex items-center gap-1">
                              <MapPin className="h-3 w-3 shrink-0" />
                              {formatLocationShort(primaryLocation)}
                              <LocalBadge
                                isLocal={primaryLocation.isLocal}
                                country={primaryLocation.country}
                              />
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {/* Usage Percentage */}
                  <Badge variant="outline" className="flex-shrink-0 font-mono">
                    {percentage}%
                  </Badge>
                </div>
              );
            })}
          </div>

          {hasMore && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-3 w-full"
              onClick={() => {
                setIsExpanded(!isExpanded);
              }}
            >
              {isExpanded ? (
                <>
                  <ChevronUp className="mr-2 h-4 w-4" />
                  {t('common:actions.showLess')}
                </>
              ) : (
                <>
                  <ChevronDown className="mr-2 h-4 w-4" />
                  {t('pages:userDetail.viewAllMore', {
                    count: devices.length - INITIAL_DISPLAY_COUNT,
                  })}
                </>
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
