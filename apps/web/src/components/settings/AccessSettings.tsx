import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError } from '@/components/ui/field';
import { AutosaveSwitchField, SaveStatusIndicator } from '@/components/ui/autosave-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Shield, KeyRound } from 'lucide-react';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { useAuth } from '@/hooks/useAuth';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';
import { useSettings, useServers } from '@/hooks/queries';
import type { Server } from '@tracearr/shared';

export function AccessSettings() {
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const { data: serversData, isLoading: serversLoading } = useServers();
  const { user } = useAuth();

  const allowGuestAccessField = useDebouncedSave('allowGuestAccess', settings?.allowGuestAccess);
  const primaryAuthMethodField = useDebouncedSave('primaryAuthMethod', settings?.primaryAuthMethod);

  const isLoading = settingsLoading || serversLoading;
  // Handle both array and wrapped response formats
  const servers = Array.isArray(serversData)
    ? serversData
    : ((serversData as unknown as { data?: Server[] })?.data ?? []);
  const hasJellyfinServer = servers.some((s) => s.type === 'jellyfin');
  const hasLocalCredentials = user?.hasPassword ?? false;

  const showAuthMethodSelector = hasLocalCredentials && hasJellyfinServer;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="h-5 w-5" />
          Access Control
        </CardTitle>
        <CardDescription>Configure who can access Tracearr</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <FieldGroup>
          <AutosaveSwitchField
            id="allowGuestAccess"
            label="Allow Guest Access"
            description="When disabled, only the server owner can log in to Tracearr"
            checked={false}
            onChange={() => undefined}
            disabled
            status={allowGuestAccessField.status}
            errorMessage={allowGuestAccessField.errorMessage}
            onRetry={allowGuestAccessField.retry}
            onReset={allowGuestAccessField.reset}
          />

          {showAuthMethodSelector && (
            <Field>
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="primaryAuthMethod">Primary Authentication Method</FieldLabel>
                <SaveStatusIndicator status={primaryAuthMethodField.status} />
              </div>
              <Select
                value={primaryAuthMethodField.value ?? 'local'}
                onValueChange={(value: 'jellyfin' | 'local') => {
                  primaryAuthMethodField.setValue(value);
                }}
              >
                <SelectTrigger
                  id="primaryAuthMethod"
                  className="w-full"
                  aria-invalid={primaryAuthMethodField.status === 'error'}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">
                    <div className="flex items-center gap-2">
                      <KeyRound className="h-4 w-4" />
                      <span>Local Account</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="jellyfin">
                    <div className="flex items-center gap-2">
                      <MediaServerIcon type="jellyfin" className="h-4 w-4" />
                      <span>Jellyfin Admin</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>
                Choose which authentication method is shown by default on the login page
              </FieldDescription>
              {primaryAuthMethodField.status === 'error' && primaryAuthMethodField.errorMessage && (
                <div className="flex items-center justify-between">
                  <FieldError>{primaryAuthMethodField.errorMessage}</FieldError>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={primaryAuthMethodField.retry}
                      className="h-6 px-2 text-xs"
                    >
                      Retry
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={primaryAuthMethodField.reset}
                      className="h-6 px-2 text-xs"
                    >
                      Reset
                    </Button>
                  </div>
                </div>
              )}
            </Field>
          )}
        </FieldGroup>

        <div className="bg-muted/50 rounded-lg p-4">
          <p className="text-muted-foreground text-sm">
            <strong>Note:</strong> In v1, Tracearr only supports single-owner access. Even with
            guest access enabled, guests can only view their own sessions and violations.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
