/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- eslint can't resolve @tracearr/shared types but TS compiles fine */
import { useState } from 'react';
import {
  Monitor,
  Wifi,
  Globe,
  Check,
  X,
  Loader2,
  ChevronDown,
  ChevronRight,
  Lock,
  Edit3,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { PlexDiscoveredServer, PlexDiscoveredConnection } from '@tracearr/shared';
import type { PlexServerInfo, PlexServerConnection } from '@/lib/api';

/**
 * Props for PlexServerSelector component
 *
 * Two modes:
 * 1. Discovery mode (Settings): servers with tested connections, uses recommendedUri
 * 2. Signup mode (Login): servers without testing, user picks any connection
 */
export interface PlexServerSelectorProps {
  /**
   * Servers to display - can be either discovered (with testing) or basic (signup flow)
   */
  servers: PlexDiscoveredServer[] | PlexServerInfo[];

  /**
   * Called when user selects a server
   * @param serverUri - The selected connection URI
   * @param serverName - The server name
   * @param clientIdentifier - The server's unique identifier
   */
  onSelect: (serverUri: string, serverName: string, clientIdentifier: string) => void;

  /**
   * Whether a connection attempt is in progress
   */
  connecting?: boolean;

  /**
   * Name of server currently being connected to
   */
  connectingToServer?: string | null;

  /**
   * Called when user clicks cancel/back
   */
  onCancel?: () => void;

  /**
   * Show cancel button (default true)
   */
  showCancel?: boolean;

  /**
   * Additional className for the container
   */
  className?: string;
}

/**
 * Type guard to check if a server has discovery info (tested connections)
 */
function isDiscoveredServer(
  server: PlexDiscoveredServer | PlexServerInfo
): server is PlexDiscoveredServer {
  return 'recommendedUri' in server;
}

/**
 * Type guard to check if a connection has test results
 */
function isDiscoveredConnection(
  conn: PlexDiscoveredConnection | PlexServerConnection
): conn is PlexDiscoveredConnection {
  return 'reachable' in conn;
}

/**
 * Format latency for display
 */
function formatLatency(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * PlexServerSelector - Displays Plex servers grouped by server with connection options
 *
 * Used in two contexts:
 * 1. Settings page: Shows tested connections with reachability status and auto-selects best
 * 2. Login page: Shows all connections for user selection during signup
 */
export function PlexServerSelector({
  servers,
  onSelect,
  connecting = false,
  connectingToServer = null,
  onCancel,
  showCancel = true,
  className,
}: PlexServerSelectorProps) {
  // Track which servers have expanded connection lists
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  // Track servers showing all connections (bypassing filtering)
  const [showAllConnections, setShowAllConnections] = useState<Set<string>>(new Set());
  // Custom URL input state
  const [customUrlServer, setCustomUrlServer] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState('');

  const toggleExpanded = (clientIdentifier: string) => {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      if (next.has(clientIdentifier)) {
        next.delete(clientIdentifier);
      } else {
        next.add(clientIdentifier);
      }
      return next;
    });
  };

  const toggleShowAll = (clientIdentifier: string) => {
    setShowAllConnections((prev) => {
      const next = new Set(prev);
      if (next.has(clientIdentifier)) {
        next.delete(clientIdentifier);
      } else {
        next.add(clientIdentifier);
      }
      return next;
    });
  };

  const handleCustomUrlSubmit = (server: PlexDiscoveredServer | PlexServerInfo) => {
    if (!customUrl.trim()) return;
    let url = customUrl.trim();
    // Add protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `http://${url}`;
    }
    onSelect(url, server.name, server.clientIdentifier);
    setCustomUrl('');
    setCustomUrlServer(null);
  };

  const handleQuickConnect = (server: PlexDiscoveredServer | PlexServerInfo) => {
    // For discovered servers, use recommended URI; for basic, use first connection
    const uri = isDiscoveredServer(server) ? server.recommendedUri : server.connections[0]?.uri;

    if (!uri) return;

    onSelect(uri, server.name, server.clientIdentifier);
  };

  const handleConnectionSelect = (
    server: PlexDiscoveredServer | PlexServerInfo,
    connection: PlexDiscoveredConnection | PlexServerConnection
  ) => {
    onSelect(connection.uri, server.name, server.clientIdentifier);
  };

  if (servers.length === 0) {
    return (
      <div className={cn('text-muted-foreground py-8 text-center', className)}>
        <Monitor className="mx-auto mb-3 h-12 w-12 opacity-50" />
        <p>No Plex servers found</p>
        <p className="mt-1 text-sm">Make sure you own at least one Plex server</p>
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {servers.map((server) => {
        const clientId = server.clientIdentifier;
        const isExpanded = expandedServers.has(clientId);
        const showingAll = showAllConnections.has(clientId);
        const showingCustomUrl = customUrlServer === clientId;
        const isDiscovered = isDiscoveredServer(server);
        const hasRecommended = isDiscovered && server.recommendedUri;
        const isConnecting = connectingToServer === server.name;

        // For discovered servers, find recommended connection
        const recommendedConn = isDiscovered
          ? server.connections.find((c) => c.uri === server.recommendedUri)
          : null;

        // Count reachable connections for discovered servers
        const reachableCount = isDiscovered
          ? server.connections.filter((c) => c.reachable).length
          : server.connections.length;

        return (
          <div key={clientId} className="bg-card rounded-lg border p-4">
            {/* Server Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-lg">
                  <Monitor className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h3 className="truncate font-medium">{server.name}</h3>
                  <p className="text-muted-foreground text-xs">
                    {server.platform} • v{server.version}
                  </p>
                </div>
              </div>

              {/* Quick Connect Button */}
              {hasRecommended && (
                <Button size="sm" onClick={() => handleQuickConnect(server)} disabled={connecting}>
                  {isConnecting ? (
                    <>
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    'Connect'
                  )}
                </Button>
              )}

              {/* No recommended - need to select manually */}
              {isDiscovered && !hasRecommended && (
                <span className="text-muted-foreground text-xs">No reachable connections</span>
              )}
            </div>

            {/* Recommended Connection Preview (for discovered servers) */}
            {recommendedConn && isDiscoveredConnection(recommendedConn) && (
              <div className="mt-3 flex items-center gap-2 text-sm">
                <Check className="h-4 w-4 text-green-500" />
                <span className="text-muted-foreground">
                  {recommendedConn.local ? 'Local' : 'Remote'}: {recommendedConn.address}:
                  {recommendedConn.port}
                </span>
                {recommendedConn.latencyMs !== null && (
                  <span className="text-muted-foreground text-xs">
                    ({formatLatency(recommendedConn.latencyMs)})
                  </span>
                )}
              </div>
            )}

            {/* Connection Count & Expand Toggle */}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => toggleExpanded(clientId)}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                {reachableCount} of {server.connections.length} connections
                {isDiscovered ? ' reachable' : ' available'}
              </button>

              {/* Show all toggle (for discovered servers with filtered connections) */}
              {isDiscovered && reachableCount < server.connections.length && (
                <button
                  type="button"
                  onClick={() => toggleShowAll(clientId)}
                  className={cn(
                    'text-xs transition-colors',
                    showingAll
                      ? 'text-primary hover:text-primary/80'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {showingAll ? 'Hide filtered' : 'Show all'}
                </button>
              )}

              {/* Custom URL toggle */}
              <button
                type="button"
                onClick={() => {
                  if (showingCustomUrl) {
                    setCustomUrlServer(null);
                    setCustomUrl('');
                  } else {
                    setCustomUrlServer(clientId);
                  }
                }}
                className={cn(
                  'flex items-center gap-1 text-xs transition-colors',
                  showingCustomUrl
                    ? 'text-primary hover:text-primary/80'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Edit3 className="h-3 w-3" />
                Custom URL
              </button>
            </div>

            {/* Custom URL Input */}
            {showingCustomUrl && (
              <div className="mt-3 flex gap-2">
                <Input
                  type="text"
                  placeholder="https://plex.example.com:32400"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleCustomUrlSubmit(server);
                    }
                    if (e.key === 'Escape') {
                      setCustomUrlServer(null);
                      setCustomUrl('');
                    }
                  }}
                  disabled={connecting}
                  className="h-8 flex-1 text-sm"
                />
                <Button
                  size="sm"
                  onClick={() => handleCustomUrlSubmit(server)}
                  disabled={connecting || !customUrl.trim()}
                >
                  Connect
                </Button>
              </div>
            )}

            {/* Expanded Connection List */}
            {isExpanded && (
              <div className="border-muted mt-3 space-y-1.5 border-l-2 pl-2">
                {server.connections.map((conn) => {
                  const isDiscoveredConn = isDiscoveredConnection(conn);
                  const isReachable = isDiscoveredConn ? conn.reachable : true;
                  // Allow clicking unreachable connections when showingAll is enabled
                  const canClick = isReachable || showingAll;
                  const isRecommended = isDiscovered && conn.uri === server.recommendedUri;

                  return (
                    <button
                      key={conn.uri}
                      type="button"
                      onClick={() => canClick && handleConnectionSelect(server, conn)}
                      disabled={connecting || !canClick}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
                        canClick
                          ? 'hover:bg-muted cursor-pointer'
                          : 'cursor-not-allowed opacity-50',
                        !isReachable && canClick && 'opacity-70',
                        isRecommended && 'bg-muted/50 ring-primary/20 ring-1'
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {/* Reachability indicator */}
                        {isDiscoveredConn ? (
                          conn.reachable ? (
                            <Check className="h-3.5 w-3.5 flex-shrink-0 text-green-500" />
                          ) : (
                            <X className="h-3.5 w-3.5 flex-shrink-0 text-red-500" />
                          )
                        ) : conn.local ? (
                          <Wifi className="h-3.5 w-3.5 flex-shrink-0 text-green-500" />
                        ) : (
                          <Globe className="h-3.5 w-3.5 flex-shrink-0 text-blue-500" />
                        )}

                        {/* Connection details */}
                        <span className="truncate">
                          {conn.local ? 'Local' : 'Remote'}: {conn.address}:{conn.port}
                        </span>

                        {/* Secure badge for HTTPS */}
                        {conn.uri.startsWith('https://') && (
                          <span className="inline-flex flex-shrink-0 items-center gap-0.5 text-xs font-medium text-green-600 dark:text-green-500">
                            <Lock className="h-3 w-3" />
                            Secure
                          </span>
                        )}

                        {/* Unreachable warning when shown via "Show all" */}
                        {!isReachable && showingAll && (
                          <span className="inline-flex flex-shrink-0 items-center gap-0.5 text-xs font-medium text-amber-600 dark:text-amber-500">
                            <AlertTriangle className="h-3 w-3" />
                            May not connect
                          </span>
                        )}

                        {/* Recommended badge */}
                        {isRecommended && (
                          <span className="text-primary flex-shrink-0 text-xs font-medium">
                            Recommended
                          </span>
                        )}
                      </div>

                      {/* Latency */}
                      {isDiscoveredConn && conn.reachable && conn.latencyMs !== null && (
                        <span className="text-muted-foreground flex-shrink-0 text-xs">
                          {formatLatency(conn.latencyMs)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* For non-discovered servers (signup flow), show simple connection buttons if no expand */}
            {!isDiscovered && !isExpanded && (
              <div className="mt-3 space-y-1.5">
                {server.connections.slice(0, 2).map((conn) => (
                  <Button
                    key={conn.uri}
                    variant="outline"
                    size="sm"
                    className="w-full justify-between"
                    onClick={() => handleConnectionSelect(server, conn)}
                    disabled={connecting}
                  >
                    <div className="flex items-center gap-2">
                      {conn.local ? (
                        <Wifi className="h-3 w-3 text-green-500" />
                      ) : (
                        <Globe className="h-3 w-3 text-blue-500" />
                      )}
                      <span className="text-xs">
                        {conn.local ? 'Local' : 'Remote'}: {conn.address}:{conn.port}
                      </span>
                      {conn.uri.startsWith('https://') && (
                        <span className="inline-flex items-center gap-0.5 text-xs font-medium text-green-600 dark:text-green-500">
                          <Lock className="h-3 w-3" />
                          Secure
                        </span>
                      )}
                    </div>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                ))}
                {server.connections.length > 2 && (
                  <button
                    type="button"
                    onClick={() => toggleExpanded(clientId)}
                    className="text-muted-foreground hover:text-foreground w-full py-1 text-xs"
                  >
                    +{server.connections.length - 2} more connections
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Connecting status */}
      {connectingToServer && (
        <div className="text-muted-foreground flex items-center justify-center gap-2 py-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Connecting to {connectingToServer}...
        </div>
      )}

      {/* Cancel button */}
      {showCancel && onCancel && (
        <Button variant="ghost" className="w-full" onClick={onCancel} disabled={connecting}>
          Cancel
        </Button>
      )}
    </div>
  );
}
