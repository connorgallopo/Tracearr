import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, User, XCircle } from 'lucide-react';
import { SERVER_PROFILES, type ServerType } from '@tracearr/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FieldSeparator } from '@/components/ui/field';
import { SignInAgainAlert, SignInFailedAlert } from '@/components/auth/AuthFormError';
import { PlexServerSelector } from '@/components/auth/PlexServerSelector';
import { PlexSignInButton, PlexWaiting } from '@/components/auth/PlexSignIn';
import { TofaServerPicker, TofaSignInButton, TofaWaiting } from '@/components/auth/TofaSignIn';
import { usePlexSignIn } from '@/components/auth/usePlexSignIn';
import { useTofaSignIn } from '@/components/auth/useTofaSignIn';
import type { SignInFailure } from '@/lib/signInRefusal';
import { OwnerSignUpForm } from './OwnerSignUpForm';
import { ServerTypeStep } from './ServerTypePicker';
import { SetupLayout, setupPath } from './SetupLayout';
import { setupSteps } from './SetupSteps';

const OWNER_FORM_ID = 'owner-sign-up';

/** Finishes the sign-in the parent started: refreshes the session, says so, and moves on. */
type OnSignedIn = (description: string, destination: string) => Promise<void>;

/** Step 3 reached by signing in on step 2: the account is not made until a server is connected. */
function SignInPickerStep({
  serverType,
  username,
  description,
  connecting,
  error,
  onSignInAgain,
  onCancel,
  onChangeServerType,
  children,
}: {
  serverType: ServerType;
  username: string | null;
  description?: string;
  connecting: boolean;
  error: SignInFailure | null;
  onSignInAgain: () => void;
  onCancel: () => void;
  onChangeServerType: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation(['pages', 'settings']);
  const server = SERVER_PROFILES[serverType].displayName;
  const timedOut = error?.kind === 'timed-out';

  return (
    <SetupLayout
      steps={setupSteps('connect', {
        server: { detail: server, onSelect: connecting ? undefined : onChangeServerType },
        account: {
          ...(username && { detail: t('pages:setup.signedInAs', { username }) }),
          onSelect: connecting ? undefined : onCancel,
        },
      })}
      title={t('pages:setup.pickerTitle', { server })}
      description={
        username ? (
          <>
            {t('pages:setup.pickerDescription', { username })}
            {description && <> {description}</>}
          </>
        ) : (
          t('settings:plex.chooseServer')
        )
      }
      serverType={serverType}
      alert={
        timedOut && (
          <SignInAgainAlert
            title={t('pages:setup.timedOut', { server })}
            onSignInAgain={onSignInAgain}
          />
        )
      }
      back={{ onClick: onCancel, disabled: connecting }}
    >
      {!timedOut && children}
      {error?.kind === 'connect-failed' && (
        <Alert variant="destructive">
          <XCircle />
          <AlertDescription>
            {error.message ?? t('pages:login.serverConnectFailed')}
          </AlertDescription>
        </Alert>
      )}
    </SetupLayout>
  );
}

function AccountStep({
  serverType,
  claimCode,
  onSignedIn,
  onBack,
}: {
  serverType: ServerType;
  claimCode: string | undefined;
  onSignedIn: OnSignedIn;
  onBack: () => void;
}) {
  const { t } = useTranslation(['pages', 'settings', 'common']);
  const [creating, setCreating] = useState(false);
  const server = SERVER_PROFILES[serverType].displayName;
  const signUpWith = SERVER_PROFILES[serverType].addServerAuth;
  const offersSignIn = signUpWith === 'plexOAuth' || signUpWith === 'tofaCloud';
  const finishSignIn = (connectedServer?: string) =>
    connectedServer
      ? onSignedIn(
          t('pages:login.connectedTo', { name: connectedServer }),
          setupPath(serverType, 'import')
        )
      : onSignedIn(t('pages:login.accountCreated'), setupPath(serverType));
  const plex = usePlexSignIn({ claimCode, onSignedIn: finishSignIn });
  const tofa = useTofaSignIn({ purpose: 'sign-in', claimCode, onSignedIn: finishSignIn });

  const cancelSignIn = () => {
    plex.cancel();
    tofa.cancel();
  };

  const changeServerType = () => {
    cancelSignIn();
    onBack();
  };

  if (plex.step === 'server-select') {
    return (
      <SignInPickerStep
        serverType={serverType}
        username={plex.username}
        connecting={plex.connectingTo !== null}
        error={plex.error}
        onSignInAgain={() => void plex.start()}
        onCancel={plex.cancel}
        onChangeServerType={changeServerType}
      >
        <PlexServerSelector
          servers={plex.servers}
          onSelect={(uri, name, clientIdentifier) => {
            void plex.selectServer(uri, name, clientIdentifier);
          }}
          connecting={plex.connectingTo !== null}
          connectingToServer={plex.connectingTo}
          showCancel={false}
          onTestCustomUrl={plex.testCustomUrl}
        />
      </SignInPickerStep>
    );
  }

  if (tofa.step === 'select-server') {
    return (
      <SignInPickerStep
        serverType={serverType}
        username={tofa.username}
        description={t('pages:tofa.pickerNote')}
        connecting={tofa.connectingTo !== null}
        error={tofa.error}
        onSignInAgain={() => void tofa.start()}
        onCancel={tofa.cancel}
        onChangeServerType={changeServerType}
      >
        <TofaServerPicker
          servers={tofa.servers}
          connectingTo={tofa.connectingTo}
          unreachable={tofa.unreachable}
          onConnect={(serverId, url) => void tofa.connect(serverId, url)}
        />
      </SignInPickerStep>
    );
  }

  const plexWaiting = plex.step === 'waiting';
  const tofaWaiting = tofa.step === 'waiting';
  const waiting = plexWaiting || tofaWaiting;
  const steps = setupSteps('account', {
    server: { detail: server, onSelect: changeServerType },
  });
  let description = t('pages:setup.ownerDescription');
  if (plexWaiting) description = t('pages:setup.plexWaitingDescription');
  else if (tofaWaiting) description = t('pages:tofa.waitingDescription');
  else if (offersSignIn) description = t('pages:setup.ownerDescriptionSignIn', { server });

  return (
    <SetupLayout
      steps={steps}
      title={tofaWaiting ? t('pages:tofa.signIn') : t('pages:setup.ownerTitle')}
      description={description}
      alert={
        <>
          <SignInFailedAlert error={plex.error} onSignInAgain={() => void plex.start()} />
          <SignInFailedAlert error={tofa.error} onSignInAgain={() => void tofa.start()} />
          {tofa.step === 'no-servers' && (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertTitle>{t('pages:tofa.noServersTitle')}</AlertTitle>
              <AlertDescription>
                {t('pages:tofa.noServersPassword', { username: tofa.username })}
              </AlertDescription>
            </Alert>
          )}
          {tofa.step === 'all-connected' && (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertTitle>{t('settings:servers.allServersConnected')}</AlertTitle>
              <AlertDescription>{t('settings:servers.allServersConnectedDesc')}</AlertDescription>
            </Alert>
          )}
        </>
      }
      back={{ onClick: waiting ? cancelSignIn : onBack }}
      actions={
        !waiting && (
          <Button type="submit" form={OWNER_FORM_ID} disabled={creating}>
            {creating ? <Loader2 className="animate-spin" /> : <User />}
            {t('settings:account.createAccount')}
          </Button>
        )
      }
    >
      {plexWaiting && (
        <PlexWaiting authUrl={plex.authUrl} onCancel={plex.cancel} showCancel={false} />
      )}
      {tofaWaiting && (
        <TofaWaiting
          verificationUri={tofa.verificationUri}
          userCode={tofa.userCode}
          expiresAt={tofa.expiresAt}
        />
      )}
      {!waiting && (
        <div className="flex flex-col gap-6">
          {signUpWith === 'plexOAuth' && (
            <PlexSignInButton
              label={t('pages:login.continueWith', { provider: server })}
              onClick={() => void plex.start()}
            />
          )}
          {signUpWith === 'tofaCloud' && (
            <TofaSignInButton
              label={t('pages:login.continueWith', { provider: server })}
              onClick={() => void tofa.start()}
            />
          )}
          {offersSignIn && <FieldSeparator>{t('common:or')}</FieldSeparator>}
          <OwnerSignUpForm
            formId={OWNER_FORM_ID}
            onPendingChange={setCreating}
            claimCode={claimCode}
            onCreated={() => onSignedIn(t('pages:login.accountCreated'), setupPath(serverType))}
          />
        </div>
      )}
    </SetupLayout>
  );
}

/** First run: pick the media server, then create the owner account in the way that fits it. */
export function FirstRun({
  claimCode,
  onSignedIn,
}: {
  claimCode: string | undefined;
  onSignedIn: OnSignedIn;
}) {
  const [serverType, setServerType] = useState<ServerType | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  if (serverType && confirmed) {
    return (
      <AccountStep
        serverType={serverType}
        claimCode={claimCode}
        onSignedIn={onSignedIn}
        onBack={() => setConfirmed(false)}
      />
    );
  }

  return (
    <ServerTypeStep
      steps={setupSteps('server')}
      value={serverType}
      onChange={setServerType}
      onContinue={() => setConfirmed(true)}
    />
  );
}
