import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { KeyRound, Users, X } from 'lucide-react';
import {
  LOGIN_ACCESS,
  type LoginAccess,
  type LoginMethods,
  type Server,
  type ServerUserWithIdentity,
} from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { FieldError, FieldGroup } from '@/components/ui/field';
import { AutosaveSwitchField, SaveStatusIndicator } from '@/components/ui/autosave-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { ServerBadge } from '@/components/server/ServerBadge';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { UserCell } from '@/components/users/UserCell';
import {
  useServers,
  useSettings,
  useUpdateServer,
  useUpdateSettings,
  useUpdateUserAccess,
  useUsers,
} from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';
import { useMutationSaveStatus } from '@/hooks/useMutationSaveStatus';

interface LoginMethodSwitchProps {
  method: keyof LoginMethods;
  label: string;
  description?: string;
  checked: boolean;
  /** The last method still on cannot be turned off, so the switch is held rather than refused. */
  lastWayIn?: boolean;
}

// The server can refuse a switch (the last way in for the owner), so the value comes from the
// cache, which the mutation rolls back, rather than from local state that would keep it flipped.
function LoginMethodSwitch({
  method,
  label,
  description,
  checked,
  lastWayIn,
}: LoginMethodSwitchProps) {
  const { t } = useTranslation('settings');
  const update = useUpdateSettings({ silent: true });
  const status = useMutationSaveStatus(update);

  return (
    <AutosaveSwitchField
      id={`loginMethods-${method}`}
      label={label}
      description={lastWayIn ? t('memberLogin.signIn.onlyWay') : description}
      checked={checked}
      disabled={lastWayIn}
      onChange={(next) => update.mutate({ loginMethods: { [method]: next } })}
      status={status}
      errorMessage={update.error?.message}
      onReset={update.reset}
    />
  );
}

// Saved at once rather than debounced: turning it on signs people out.
function SsoOnlySwitch({ checked }: { checked: boolean }) {
  const { t } = useTranslation('settings');
  const update = useUpdateSettings({ silent: true });
  const status = useMutationSaveStatus(update);

  return (
    <AutosaveSwitchField
      id="memberSsoOnly"
      label={t('memberLogin.signIn.ssoOnly')}
      description={t('memberLogin.signIn.ssoOnlyDesc')}
      checked={checked}
      onChange={(next) => update.mutate({ memberSsoOnly: next })}
      status={status}
      errorMessage={update.error?.message}
      onReset={update.reset}
    />
  );
}

function OwnerMethods({ methods }: { methods: LoginMethods }) {
  const { t } = useTranslation('settings');
  const { data: settings } = useSettings();
  const { user } = useAuth();

  const held = {
    local: user?.hasPassword === true,
    plex: user?.hasPlexLinked === true,
    oidc: settings?.oidcConfigured === true,
  } as const;
  const shown = (['local', 'plex', 'oidc'] as const).filter((method) => held[method]);
  const waysIn = shown.filter((method) => methods[method]).length;

  return (
    <FieldGroup>
      {shown.map((method) => (
        <LoginMethodSwitch
          key={method}
          method={method}
          label={t(`memberLogin.signIn.${method}`)}
          description={t(`memberLogin.signIn.${method}Desc`)}
          checked={methods[method]}
          lastWayIn={methods[method] && waysIn <= 1}
        />
      ))}
    </FieldGroup>
  );
}

function ServerLoginSwitch({ server }: { server: Server }) {
  const update = useUpdateServer({ silent: true });
  const status = useMutationSaveStatus(update);
  const checked = update.isPending
    ? (update.variables?.allowMemberLogin ?? false)
    : (server.allowMemberLogin ?? false);

  return (
    <AutosaveSwitchField
      id={`allowMemberLogin-${server.id}`}
      label={
        <span className="flex min-w-0 items-center gap-2">
          <MediaServerIcon type={server.type} alt="" className="size-4 shrink-0" />
          <ServerBadge server={server} />
        </span>
      }
      checked={checked}
      onChange={(next) => update.mutate({ id: server.id, allowMemberLogin: next })}
      status={status}
      errorMessage={update.error?.message}
      onReset={update.reset}
    />
  );
}

function ServerRows() {
  const { t } = useTranslation('settings');
  const { data: servers, isLoading, isError } = useServers();

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (isError) return <FieldError>{t('memberLogin.serversLoadFailed')}</FieldError>;

  // A historical server is no longer contacted, so it cannot sign anyone in
  const live = (servers ?? []).filter((server) => !server.historicalAt);

  if (live.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t('memberLogin.noServers')}{' '}
        <Link to="/settings/servers/connections" className="text-foreground underline">
          {t('memberLogin.addServer')}
        </Link>
      </p>
    );
  }

  return (
    <FieldGroup>
      {live.map((server) => (
        <ServerLoginSwitch key={server.id} server={server} />
      ))}
    </FieldGroup>
  );
}

const personName = (row: ServerUserWithIdentity) => row.identityName ?? row.username;

function OverrideRow({ row }: { row: ServerUserWithIdentity }) {
  const { t } = useTranslation('settings');
  const update = useUpdateUserAccess();
  const status = useMutationSaveStatus(update);
  const name = personName(row);
  const pending = update.isPending ? update.variables?.data : undefined;
  const loginAccess = pending?.loginAccess ?? row.loginAccess;
  const role = pending?.role ?? row.role;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
      <div className="min-w-0 flex-1">
        <UserCell
          serverUserId={row.id}
          username={row.username}
          identityName={row.identityName}
          thumbUrl={row.thumbUrl}
          serverId={row.serverId}
        />
      </div>
      <Select
        value={loginAccess}
        onValueChange={(next) => {
          const picked = LOGIN_ACCESS.find((access) => access === next);
          if (picked) update.mutate({ id: row.id, data: { loginAccess: picked } });
        }}
      >
        <SelectTrigger className="w-28" aria-label={t('memberLogin.signIn.accessLabel', { name })}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="allow">{t('memberLogin.signIn.allow')}</SelectItem>
          <SelectItem value="block">{t('memberLogin.signIn.block')}</SelectItem>
        </SelectContent>
      </Select>
      <Select
        value={role}
        onValueChange={(next) => {
          if (next === 'admin' || next === 'member') {
            update.mutate({ id: row.id, data: { role: next } });
          }
        }}
      >
        <SelectTrigger className="w-28" aria-label={t('memberLogin.signIn.roleLabel', { name })}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="admin">{t('memberLogin.signIn.admin')}</SelectItem>
          <SelectItem value="member">{t('memberLogin.signIn.member')}</SelectItem>
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`${t('memberLogin.signIn.backToDefault')}: ${name}`}
        disabled={update.isPending}
        onClick={() => update.mutate({ id: row.id, data: { loginAccess: 'default' } })}
      >
        <X />
      </Button>
      <SaveStatusIndicator status={status} className="basis-full" />
      {update.error && <FieldError className="basis-full">{update.error.message}</FieldError>}
    </div>
  );
}

function AddOverride({ taken }: { taken: Set<string> }) {
  const { t } = useTranslation('settings');
  const update = useUpdateUserAccess();
  const [picked, setPicked] = useState<string | null>(null);
  // ponytail: the combobox filters the first 100 people client-side, like the automation scope
  // picker; wire its search to the roster search param if a roster outgrows that.
  const { data } = useUsers({ pageSize: 100 });
  const options = (data?.data ?? [])
    .filter((row) => (row.role === 'admin' || row.role === 'member') && !taken.has(row.userId))
    .map((row) => ({ value: row.id, label: personName(row) }));

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Combobox
        value={picked}
        onChange={setPicked}
        options={options}
        placeholder={t('memberLogin.signIn.addPerson')}
        searchPlaceholder={t('memberLogin.signIn.searchPeople')}
        emptyText={t('memberLogin.signIn.nobodyFound')}
        aria-label={t('memberLogin.signIn.addPerson')}
        className="sm:max-w-xs"
      />
      {(['allow', 'block'] as const satisfies readonly LoginAccess[]).map((access) => (
        <Button
          key={access}
          variant="outline"
          disabled={!picked || update.isPending}
          onClick={() => {
            if (!picked) return;
            update.mutate(
              { id: picked, data: { loginAccess: access } },
              { onSuccess: () => setPicked(null) }
            );
          }}
        >
          {t(`memberLogin.signIn.${access}`)}
        </Button>
      ))}
      {update.error && <FieldError>{update.error.message}</FieldError>}
    </div>
  );
}

function Overrides() {
  const { t } = useTranslation('settings');
  const { data, isLoading, isError } = useUsers({ signInOverride: true, pageSize: 100 });
  const rows = data?.data ?? [];

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">{t('memberLogin.signIn.overrides')}</p>
        <p className="text-muted-foreground text-sm">{t('memberLogin.signIn.overridesDesc')}</p>
      </div>
      {isLoading && <Skeleton className="h-14 w-full" />}
      {isError && <FieldError>{t('memberLogin.signIn.overridesLoadFailed')}</FieldError>}
      {!isLoading && !isError && rows.length === 0 && (
        <p className="text-muted-foreground text-sm">{t('memberLogin.signIn.overridesEmpty')}</p>
      )}
      {rows.map((row) => (
        <OverrideRow key={row.userId} row={row} />
      ))}
      <AddOverride taken={new Set(rows.map((row) => row.userId))} />
    </div>
  );
}

export function MemberLogin() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: settings } = useSettings();
  const serverActivity = useDebouncedSave('memberServerActivity', settings?.memberServerActivity);

  const methods = settings?.loginMethods;

  return (
    <SettingsSection
      title={t('nav.sections.memberLogin')}
      description={t('nav.descriptions.memberLogin')}
    >
      {!methods ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-5 w-5" />
                {t('memberLogin.signIn.title')}
              </CardTitle>
              <CardDescription>{t('memberLogin.signIn.titleDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <OwnerMethods methods={methods} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                {t('memberLogin.signIn.membersTitle')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <FieldGroup>
                <LoginMethodSwitch
                  method="member"
                  label={t('memberLogin.signIn.media')}
                  description={t('memberLogin.signIn.mediaDesc')}
                  checked={methods.member}
                />
                <div className="ml-6 space-y-3 border-l pl-4">
                  <p className="text-muted-foreground text-sm">{t('memberLogin.signIn.servers')}</p>
                  <ServerRows />
                </div>
                {(settings?.oidcConfigured || settings?.memberSsoOnly) && (
                  <SsoOnlySwitch checked={settings.memberSsoOnly} />
                )}
              </FieldGroup>
              <Overrides />
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <AutosaveSwitchField
                id="memberServerActivity"
                label={t('memberLogin.serverActivity')}
                description={t('memberLogin.serverActivityDesc')}
                checked={serverActivity.value ?? false}
                onChange={serverActivity.setValue}
                status={serverActivity.status}
                errorMessage={serverActivity.errorMessage}
                onRetry={serverActivity.retry}
                onReset={serverActivity.reset}
              />
            </CardContent>
          </Card>
        </>
      )}
    </SettingsSection>
  );
}
