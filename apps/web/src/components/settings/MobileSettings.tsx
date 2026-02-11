import { useState, useEffect } from 'react';
import { NavLink } from 'react-router';
import { QRCodeSVG } from 'qrcode.react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Trash2,
  Loader2,
  Smartphone,
  Copy,
  LogOut,
  Plus,
  Clock,
  Info,
  CheckCircle2,
  Pencil,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  useSettings,
  useMobileConfig,
  useEnableMobile,
  useDisableMobile,
  useGeneratePairToken,
  useUpdateMobileSession,
  useRevokeSession,
  useRevokeMobileSessions,
} from '@/hooks/queries';
import type { MobileSession, MobileQRPayload } from '@tracearr/shared';

function MobileSessionCard({ session }: { session: MobileSession }) {
  const revokeSession = useRevokeSession();
  const updateSession = useUpdateMobileSession();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [editDeviceName, setEditDeviceName] = useState(session.deviceName);

  return (
    <>
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="flex items-center gap-4">
          <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-lg">
            <Smartphone className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">{session.deviceName}</h3>
              <button
                type="button"
                onClick={() => {
                  setEditDeviceName(session.deviceName);
                  setShowRenameDialog(true);
                }}
                className="hover:text-primary"
                title="Rename device"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <span className="bg-muted rounded px-2 py-0.5 text-xs">
                {session.platform === 'ios'
                  ? 'iOS'
                  : session.platform === 'android'
                    ? 'Android'
                    : session.platform}
              </span>
            </div>
            <p className="text-muted-foreground text-sm">
              Last seen {formatDistanceToNow(new Date(session.lastSeenAt), { addSuffix: true })}
            </p>
            <p className="text-muted-foreground text-xs">
              Connected {format(new Date(session.createdAt), 'MMM d, yyyy')}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(true)}>
          <Trash2 className="text-destructive h-4 w-4" />
        </Button>
      </div>

      <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename Device</DialogTitle>
            <DialogDescription>Enter a name to identify this device in the list.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="device-name">Device name</Label>
              <Input
                id="device-name"
                value={editDeviceName}
                onChange={(e) => setEditDeviceName(e.target.value)}
                placeholder="e.g. iPhone 15"
                maxLength={100}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRenameDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const name = editDeviceName.trim();
                if (name && name !== session.deviceName) {
                  updateSession.mutate(
                    { id: session.id, deviceName: name },
                    {
                      onSuccess: () => setShowRenameDialog(false),
                    }
                  );
                }
              }}
              disabled={
                updateSession.isPending ||
                !editDeviceName.trim() ||
                editDeviceName.trim() === session.deviceName
              }
            >
              {updateSession.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Remove Device"
        description={`Are you sure you want to remove ${session.deviceName}? This device will need to pair again to reconnect.`}
        confirmLabel="Remove"
        onConfirm={() => {
          revokeSession.mutate(session.id);
          setShowDeleteConfirm(false);
        }}
        isLoading={revokeSession.isPending}
      />
    </>
  );
}

export function MobileSettings() {
  const { data: config, isLoading } = useMobileConfig();
  const { data: settings } = useSettings();
  const enableMobile = useEnableMobile();
  const disableMobile = useDisableMobile();
  const generatePairToken = useGeneratePairToken();
  const revokeMobileSessions = useRevokeMobileSessions();

  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);
  const [showQRDialog, setShowQRDialog] = useState(false);
  const [pairToken, setPairToken] = useState<{ token: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);

  // Timer for token expiration
  useEffect(() => {
    if (!pairToken?.expiresAt) {
      setTimeLeft(null);
      return;
    }

    const updateTimer = () => {
      const now = Date.now();
      const expiresAt = new Date(pairToken.expiresAt).getTime();
      const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
      setTimeLeft(remaining);

      if (remaining === 0) {
        setPairToken(null);
        setShowQRDialog(false);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [pairToken]);

  const handleAddDevice = async () => {
    try {
      const token = await generatePairToken.mutateAsync();
      if (token?.token && token?.expiresAt) {
        setPairToken(token);
        setShowQRDialog(true);
      } else {
        console.error('Invalid token response:', token);
        toast.error('Failed to Generate Token', {
          description: 'Received invalid token data from server.',
        });
      }
    } catch (err) {
      // Error already handled by mutation's onError, but log for support
      console.error('Token generation error:', err);
    }
  };

  const handleCopyToken = async () => {
    if (pairToken?.token) {
      try {
        await navigator.clipboard.writeText(pairToken.token);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        toast.success('Token Copied', { description: 'Pair token copied to clipboard.' });
      } catch {
        toast.error('Failed to Copy', { description: 'Could not copy token to clipboard.' });
      }
    }
  };

  const getServerUrl = (): string => {
    if (settings?.externalUrl) {
      return settings.externalUrl;
    }
    let serverUrl = window.location.origin;
    if (import.meta.env.DEV) {
      serverUrl = serverUrl.replace(':5173', ':3000');
    }
    return serverUrl;
  };

  const getQRData = (): string => {
    if (!pairToken?.token) return '';
    const payload: MobileQRPayload = {
      url: getServerUrl(),
      token: pairToken.token,
      name: config?.serverName ?? 'Tracearr',
    };
    // Convert to UTF-8 bytes then base64 to handle non-ASCII characters (e.g., umlauts)
    const jsonString = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(jsonString);
    const encoded = btoa(String.fromCharCode(...bytes));
    return `tracearr://pair?data=${encoded}`;
  };

  const formatTimeLeft = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-48 w-48" />
        </CardContent>
      </Card>
    );
  }

  const deviceCount = config?.sessions?.length ?? 0;
  const maxDevices = config?.maxDevices ?? 5;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5" />
            Mobile App Access
          </CardTitle>
          <CardDescription>
            Connect the Tracearr mobile app to monitor your servers on the go
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!settings?.externalUrl && (
            <div className="flex items-start gap-2 rounded-lg bg-blue-500/10 p-3 text-sm text-blue-600 dark:text-blue-400">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Using a reverse proxy or accessing remotely? Set your{' '}
                <NavLink to="/settings" className="font-medium underline underline-offset-2">
                  External URL
                </NavLink>{' '}
                so the mobile app can connect to your server.
              </span>
            </div>
          )}
          {!config?.isEnabled ? (
            <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8">
              <div className="bg-muted rounded-full p-4">
                <Smartphone className="text-muted-foreground h-8 w-8" />
              </div>
              <div className="text-center">
                <h3 className="font-semibold">Mobile Access Disabled</h3>
                <p className="text-muted-foreground mt-1 text-sm">
                  Enable mobile access to connect the Tracearr app to your server
                </p>
              </div>
              <Button onClick={() => enableMobile.mutate()} disabled={enableMobile.isPending}>
                {enableMobile.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Enabling...
                  </>
                ) : (
                  'Enable Mobile Access'
                )}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <p className="text-muted-foreground text-sm">
                    {deviceCount} of {maxDevices} devices connected
                  </p>
                  {config.pendingTokens > 0 && (
                    <p className="text-muted-foreground text-xs">
                      {config.pendingTokens} pending token
                      {config.pendingTokens !== 1 ? 's' : ''} awaiting pairing
                    </p>
                  )}
                </div>
                <Button
                  onClick={handleAddDevice}
                  disabled={deviceCount >= maxDevices || generatePairToken.isPending}
                >
                  {generatePairToken.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 h-4 w-4" />
                  )}
                  Add Device
                </Button>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setShowDisableConfirm(true)}>
                  Disable Mobile Access
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {config?.isEnabled && config.sessions.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Smartphone className="h-5 w-5" />
                  Connected Devices
                </CardTitle>
                <CardDescription>
                  {config.sessions.length} device{config.sessions.length !== 1 ? 's' : ''} connected
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowRevokeConfirm(true)}>
                <LogOut className="mr-2 h-4 w-4" />
                Revoke All
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {config.sessions.map((session) => (
                <MobileSessionCard key={session.id} session={session} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* QR Code Dialog */}
      <Dialog
        open={showQRDialog}
        onOpenChange={(open) => {
          setShowQRDialog(open);
          if (!open) setPairToken(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pair New Device</DialogTitle>
            <DialogDescription>
              Scan the QR code with the Tracearr mobile app to pair your device.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {pairToken && (
              <>
                <div className="flex flex-col items-center gap-4">
                  <div className="rounded-lg border bg-white p-4">
                    <QRCodeSVG value={getQRData()} size={200} level="M" marginSize={0} />
                  </div>
                  {timeLeft !== null && (
                    <div className="text-muted-foreground flex items-center gap-2 text-sm">
                      <Clock className="h-4 w-4" />
                      <span>Expires in {formatTimeLeft(timeLeft)}</span>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>One-Time Pair Token</Label>
                  <div className="flex gap-2">
                    <Input readOnly value={pairToken.token} className="font-mono text-xs" />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={handleCopyToken}
                      title="Copy token"
                    >
                      {copied ? (
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    This token expires in 5 minutes and can only be used once.
                  </p>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setShowQRDialog(false);
                setPairToken(null);
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disable Confirmation Dialog */}
      <ConfirmDialog
        open={showDisableConfirm}
        onOpenChange={setShowDisableConfirm}
        title="Disable Mobile Access"
        description="Are you sure you want to disable mobile access? All connected devices will be disconnected and will need to be re-paired when you re-enable."
        confirmLabel="Disable"
        onConfirm={() => {
          disableMobile.mutate();
          setShowDisableConfirm(false);
        }}
        isLoading={disableMobile.isPending}
      />

      <ConfirmDialog
        open={showRevokeConfirm}
        onOpenChange={setShowRevokeConfirm}
        title="Revoke All Sessions"
        description="Are you sure you want to disconnect all mobile devices? They will need to pair with a new token to reconnect."
        confirmLabel="Revoke All"
        onConfirm={() => {
          revokeMobileSessions.mutate();
          setShowRevokeConfirm(false);
        }}
        isLoading={revokeMobileSessions.isPending}
      />
    </div>
  );
}
