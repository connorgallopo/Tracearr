import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { MapPin, ChevronDown, ChevronUp, Globe } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { UserLocation } from '@tracearr/shared';

interface UserLocationsCardProps {
  locations: UserLocation[];
  isLoading?: boolean;
  totalSessions?: number;
}

const INITIAL_DISPLAY_COUNT = 5;

export function UserLocationsCard({
  locations,
  isLoading,
  totalSessions = 0,
}: UserLocationsCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Locations
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-4 w-4" />
                  <div>
                    <Skeleton className="h-4 w-32" />
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

  if (locations.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Locations
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">No location data available</p>
        </CardContent>
      </Card>
    );
  }

  const displayedLocations = isExpanded ? locations : locations.slice(0, INITIAL_DISPLAY_COUNT);
  const hasMore = locations.length > INITIAL_DISPLAY_COUNT;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Locations
          </div>
          <Badge variant="secondary" className="font-normal">
            {locations.length} unique
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {displayedLocations.map((location) => {
            const locationKey = `${location.city ?? 'unknown'}-${location.country ?? 'unknown'}-${location.lat}-${location.lon}`;
            const percentage =
              totalSessions > 0 ? Math.round((location.sessionCount / totalSessions) * 100) : 0;

            return (
              <div
                key={locationKey}
                className="hover:bg-muted/50 flex items-center justify-between rounded-lg border p-3 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="bg-primary/10 flex h-8 w-8 items-center justify-center rounded-full">
                    <Globe className="text-primary h-4 w-4" />
                  </div>
                  <div>
                    <p className="font-medium">
                      {location.city ?? 'Unknown City'}
                      {location.region && (
                        <span className="text-muted-foreground">, {location.region}</span>
                      )}
                    </p>
                    <div className="text-muted-foreground flex items-center gap-2 text-xs">
                      <span>{location.country ?? 'Unknown'}</span>
                      <span>·</span>
                      <span>
                        {location.sessionCount} session{location.sessionCount !== 1 ? 's' : ''}
                      </span>
                      <span>·</span>
                      <span>
                        {formatDistanceToNow(new Date(location.lastSeenAt), { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <Badge variant="outline" className="font-mono">
                    {percentage}%
                  </Badge>
                  {location.ipAddresses.length > 1 && (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {location.ipAddresses.length} IPs
                    </p>
                  )}
                </div>
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
                Show Less
              </>
            ) : (
              <>
                <ChevronDown className="mr-2 h-4 w-4" />
                View All ({locations.length - INITIAL_DISPLAY_COUNT} more)
              </>
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
