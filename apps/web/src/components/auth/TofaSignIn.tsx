import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle, ExternalLink, Loader2, Monitor } from 'lucide-react';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { TofaCloudServer } from '@/lib/api';

const CODE = {
  code: <span className="text-foreground font-mono tracking-wider" />,
};

/** Outlined with tofa's mark; tofa has no brand color to fill a button with. */
export function TofaSignInButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="outline" size="lg" className="w-full" onClick={onClick}>
      <MediaServerIcon type="tofa" alt="" className="size-6" />
      {label}
    </Button>
  );
}

function useSecondsLeft(expiresAt: number | null) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  return expiresAt ? Math.max(0, Math.round((expiresAt - now) / 1000)) : 0;
}

export function TofaWaiting({
  verificationUri,
  userCode,
  expiresAt,
  onCancel,
}: {
  verificationUri: string | null;
  userCode: string | null;
  expiresAt: number | null;
  /** Where the page has no Back of its own. */
  onCancel?: () => void;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const seconds = useSecondsLeft(expiresAt);
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-card-raised flex flex-col gap-5 rounded-lg border p-6">
        <div className="flex items-start gap-3">
          <Loader2 className="text-primary mt-0.5 size-5 shrink-0 animate-spin" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">{t('pages:tofa.waiting')}</p>
            <p className="text-muted-foreground text-sm">{t('pages:tofa.waitingHint')}</p>
          </div>
        </div>
        {verificationUri && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button variant="outline" asChild>
              <a href={verificationUri} target="_blank" rel="noreferrer">
                <ExternalLink />
                {t('pages:tofa.openAgain')}
              </a>
            </Button>
            {expiresAt && (
              <span className="text-muted-foreground text-xs tabular-nums">
                {t('pages:tofa.expiresIn', { time })}
              </span>
            )}
          </div>
        )}
        {userCode && (
          <p className="text-muted-foreground border-t pt-4 text-xs">
            <Trans
              t={t}
              i18nKey="pages:tofa.codeFallback"
              values={{ code: userCode }}
              components={CODE}
            />
          </p>
        )}
      </div>
      {onCancel && (
        <Button variant="ghost" className="w-full" onClick={onCancel}>
          {t('common:actions.cancel')}
        </Button>
      )}
    </div>
  );
}

function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

function ServerUrlField({
  server,
  address,
  connecting,
  onConnect,
}: {
  server: TofaCloudServer;
  address: string;
  connecting: boolean;
  onConnect: (url: string) => void;
}) {
  const { t } = useTranslation(['pages', 'settings', 'common']);
  const [url, setUrl] = useState('');
  const inputId = `tofa-url-${server.id}`;

  const submit = () => {
    const typed = url.trim();
    if (!typed) return;
    onConnect(/^https?:\/\//.test(typed) ? typed : `http://${typed}`);
  };

  return (
    <>
      <p role="status" className="mt-3 flex gap-2 text-sm">
        <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" />
        <span className="text-muted-foreground">
          {address
            ? t('pages:tofa.unreachable', { name: server.name, address: hostOf(address) })
            : t('pages:tofa.noAddress', { name: server.name })}
        </span>
      </p>
      <Field className="mt-4">
        <FieldLabel htmlFor={inputId}>{t('settings:servers.serverUrl')}</FieldLabel>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            id={inputId}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={t('settings:servers.serverUrlPlaceholderTofa')}
            disabled={connecting}
            className="flex-1"
          />
          <Button type="submit" disabled={connecting || !url.trim()}>
            {t('common:actions.connect')}
          </Button>
        </form>
        <FieldDescription>{t('settings:servers.serverUrlHelpTofa')}</FieldDescription>
      </Field>
    </>
  );
}

/** The tofa servers the account owns, each with its own Connect; a row Tracearr cannot reach asks for an address. */
export function TofaServerPicker({
  servers,
  connectingTo,
  unreachable,
  onConnect,
}: {
  servers: TofaCloudServer[];
  connectingTo: string | null;
  unreachable: { serverId: string; address: string } | null;
  onConnect: (serverId: string, url?: string) => void;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const busy = connectingTo !== null;

  return (
    <ul className="flex flex-col gap-3">
      {servers.map((server) => {
        const blocked = unreachable?.serverId === server.id ? unreachable : null;
        return (
          <li key={server.id} className="bg-card rounded-lg border p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
                  <Monitor className="size-5" />
                </div>
                <h3 className="truncate font-medium">{server.name}</h3>
              </div>
              {!blocked && (
                <Button size="sm" disabled={busy} onClick={() => onConnect(server.id)}>
                  {connectingTo === server.id ? (
                    <>
                      <Loader2 className="animate-spin" />
                      {t('common:states.connecting')}
                    </>
                  ) : (
                    t('common:actions.connect')
                  )}
                </Button>
              )}
            </div>
            {blocked && (
              <ServerUrlField
                server={server}
                address={blocked.address}
                connecting={busy}
                onConnect={(url) => onConnect(server.id, url)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
