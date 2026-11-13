import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Server as ServerIcon } from 'lucide-react';
import { SERVER_PROFILES, type ServerType } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { EmptyState } from '@/components/ui/empty-state';
import { AuthFormError } from '@/components/auth/AuthFormError';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import {
  AddServerFields,
  ConnectServerButton,
} from '@/components/settings/servers/AddServerFields';
import {
  LinkAccountButton,
  useLinkPlexAccount,
} from '@/components/settings/servers/linkPlexAccount';
import { useAddServer } from '@/components/settings/servers/useAddServer';
import { Skeleton } from '@/components/ui/skeleton';
import { SetupLayout } from './SetupLayout';
import { setupSteps } from './SetupSteps';

function LinkPlexAccountPrompt({
  serverType,
  error,
  onLinked,
}: {
  serverType: ServerType;
  error: string | null;
  onLinked: () => Promise<void>;
}) {
  const { t } = useTranslation('pages');
  const { link, isLinking, linkError } = useLinkPlexAccount();

  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia>
          <MediaServerIcon type={serverType} alt="" className="size-10" />
        </EmptyMedia>
        <EmptyTitle>{t('setup.linkPlexTitle')}</EmptyTitle>
        <EmptyDescription>{t('setup.linkPlexDescription')}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <LinkAccountButton
          labelKey="settings.plex.linkPlexAccount"
          onClick={async () => {
            if (await link()) await onLinked();
          }}
          disabled={isLinking}
          isLinking={isLinking}
        />
        <AuthFormError message={linkError ?? error} />
      </EmptyContent>
    </Empty>
  );
}

/** Connects the owner's first server, of the type picked before the account existed. */
export function ConnectServerStep({
  serverType,
  account,
  connectedName,
  onConnected,
  onSkip,
  onChangeType,
}: {
  serverType: ServerType;
  account: { detail?: string };
  /** Set once a server of this type is connected; the step then only offers to move on. */
  connectedName: string | undefined;
  onConnected: () => void;
  onSkip: () => void;
  onChangeType: () => void;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const form = useAddServer({ initialType: serverType, onAdded: onConnected });
  const plexOAuth = SERVER_PROFILES[serverType].addServerAuth === 'plexOAuth';
  const name = connectedName ?? (form.addedWithoutStop ? form.serverName : undefined);
  const displayName = SERVER_PROFILES[serverType].displayName;

  useEffect(() => {
    if (plexOAuth && !connectedName) void form.loadPlexAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the step opens
  }, []);

  if (name) {
    return (
      <SetupLayout
        steps={setupSteps('connect', {
          server: { detail: displayName },
          account,
          connect: { detail: name },
        })}
        title={t('pages:setup.connectedTitle', { name })}
        description={t('pages:setup.connectedDescription')}
        serverType={serverType}
        actions={<Button onClick={onConnected}>{t('common:actions.continue')}</Button>}
      >
        {form.addedWithoutStop && <AddServerFields form={form} />}
      </SetupLayout>
    );
  }

  const loadingPlex =
    plexOAuth && (form.plexStep === 'loading' || form.plexStep === 'loading-servers');
  const { tofa } = form;
  const picking = tofa.step === 'select-server';
  // Back first undoes a tofa sign-in in progress, then goes on to change the server type.
  const connecting = tofa.connectingTo !== null;
  const back =
    tofa.step === 'idle'
      ? { onClick: onChangeType }
      : { onClick: tofa.cancel, disabled: connecting };

  return (
    <SetupLayout
      steps={setupSteps('connect', {
        server: { detail: displayName, onSelect: connecting ? undefined : onChangeType },
        account,
      })}
      title={
        picking
          ? t('pages:setup.pickerTitle', { server: displayName })
          : t('pages:setup.connectTitle', { server: displayName })
      }
      description={
        picking && tofa.username ? (
          <>
            {t('pages:setup.pickerDescription', { username: tofa.username })}{' '}
            {t('pages:tofa.pickerNote')}
          </>
        ) : (
          t('pages:setup.connectHint')
        )
      }
      serverType={serverType}
      back={back}
      actions={
        <>
          <Button variant="ghost" onClick={onSkip} disabled={connecting}>
            {t('common:actions.skip')}
          </Button>
          {form.keyFields && <ConnectServerButton form={form} />}
        </>
      }
    >
      {loadingPlex ? (
        <div className="flex flex-col gap-3">
          <span role="status" className="sr-only">
            {t('common:states.loading')}
          </span>
          <Skeleton className="h-20 w-full" aria-hidden />
          <Skeleton className="h-20 w-full" aria-hidden />
        </div>
      ) : (
        <AddServerFields
          form={form}
          className="gap-5"
          inlineCancel={false}
          noPlexAccounts={
            <LinkPlexAccountPrompt
              serverType={serverType}
              error={form.connectError}
              onLinked={form.loadPlexAccounts}
            />
          }
          noPlexServers={
            <>
              <EmptyState
                icon={ServerIcon}
                title={t('pages:settings.plex.noServersFound')}
                description={t('pages:settings.plex.noServersFoundHint')}
              >
                <Button variant="outline" onClick={() => void form.loadPlexAccounts()}>
                  {t('pages:setup.checkAgain')}
                </Button>
              </EmptyState>
              <AuthFormError message={form.connectError} />
            </>
          }
        />
      )}
    </SetupLayout>
  );
}
