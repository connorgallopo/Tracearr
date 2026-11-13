import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { SERVER_PROFILES, isServerType, type ServerType } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { ConnectServerStep } from '@/components/setup/ConnectServerStep';
import { ServerTypeStep } from '@/components/setup/ServerTypePicker';
import { SetupLayout, setupPath } from '@/components/setup/SetupLayout';
import { setupSteps } from '@/components/setup/SetupSteps';
import { ImportSources } from '@/components/settings/data/Import';
import { useAuth } from '@/hooks/useAuth';
import { useServers } from '@/hooks/queries';

interface StepContext {
  serverType: ServerType;
  /** The owner's account line on the step list; the account step is done and locked from here on. */
  account: { detail?: string };
  connectedName: string | undefined;
}

function ImportHistoryStep({
  serverType,
  account,
  connectedName,
  onBack,
}: StepContext & { onBack: () => void }) {
  const { t } = useTranslation(['pages', 'common']);
  const navigate = useNavigate();
  const [started, setStarted] = useState(false);

  return (
    <SetupLayout
      steps={setupSteps('import', {
        server: { detail: SERVER_PROFILES[serverType].displayName },
        account,
        connect: { ...(connectedName && { detail: connectedName }), onSelect: onBack },
      })}
      title={t('pages:setup.importTitle')}
      description={t('pages:setup.importDescription')}
      serverType={serverType}
      back={{ onClick: onBack }}
      actions={
        <Button variant={started ? 'default' : 'ghost'} onClick={() => void navigate('/')}>
          {started ? t('pages:setup.goToDashboard') : t('common:actions.skip')}
        </Button>
      }
    >
      <ImportSources serverType={serverType} onStarted={() => setStarted(true)} />
    </SetupLayout>
  );
}

/** The owner's first-run steps after the account exists: connect the server, then bring in history. */
export function Setup() {
  const { t } = useTranslation('pages');
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: servers } = useServers();
  const [searchParams] = useSearchParams();
  const [changingType, setChangingType] = useState(false);
  const [chosenType, setChosenType] = useState<ServerType | null>(null);
  const type = searchParams.get('type') ?? '';

  if (user?.role !== 'owner' || !isServerType(type)) {
    return <Navigate to="/" replace />;
  }

  const context: StepContext = {
    serverType: type,
    account: user.username ? { detail: t('setup.signedInAs', { username: user.username }) } : {},
    connectedName: servers?.find((server) => server.type === type)?.name,
  };

  if (changingType) {
    return (
      <ServerTypeStep
        steps={setupSteps('server').map((step) =>
          step.id === 'account' ? { ...step, status: 'done', ...context.account } : step
        )}
        value={chosenType ?? type}
        onChange={setChosenType}
        onContinue={() => {
          setChangingType(false);
          void navigate(setupPath(chosenType ?? type), { replace: true });
        }}
      />
    );
  }

  if (searchParams.get('step') === 'import') {
    return (
      <ImportHistoryStep
        {...context}
        onBack={() => void navigate(setupPath(type), { replace: true })}
      />
    );
  }

  return (
    <ConnectServerStep
      {...context}
      onConnected={() => void navigate(setupPath(type, 'import'), { replace: true })}
      onSkip={() => void navigate('/')}
      onChangeType={() => {
        setChosenType(null);
        setChangingType(true);
      }}
    />
  );
}
