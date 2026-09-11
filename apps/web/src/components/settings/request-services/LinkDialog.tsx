import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import type { RequestService, RequestServiceProbeResult, Server } from '@tracearr/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  useCreateRequestService,
  useServers,
  useTestRequestService,
  useUpdateRequestService,
} from '@/hooks/queries';
import { shortVersion } from './requestServiceFormat';

const TEST_RESULT_ID = 'request-service-test-result';

interface LinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: Server;
  existing?: RequestService;
}

/** The inputs a probe ran against, so an edit after the fact invalidates the result. */
interface TestState {
  url: string;
  apiKey: string;
  result: RequestServiceProbeResult | null;
  error: string | null;
}

export function LinkDialog({ open, onOpenChange, server, existing }: LinkDialogProps) {
  const { t } = useTranslation(['settings', 'common']);
  const [url, setUrl] = useState(existing?.url ?? '');
  const [apiKey, setApiKey] = useState('');
  const [keyVisible, setKeyVisible] = useState(false);
  const [tested, setTested] = useState<TestState | null>(null);
  const { data: servers } = useServers();
  const testService = useTestRequestService();
  const createService = useCreateRequestService();
  const updateService = useUpdateRequestService();

  const trimmedUrl = url.trim();
  const trimmedKey = apiKey.trim();
  const matchedHere = tested?.result?.matchedServerId === server.id;
  const sameInputs = tested !== null && tested.url === trimmedUrl && tested.apiKey === trimmedKey;
  const proven = matchedHere && sameInputs;

  // A blank key in edit mode means "keep the stored one", and the stored one
  // never reaches the browser, so there is nothing left to probe with.
  const needsTest = existing === undefined || trimmedKey !== '';
  const dirty =
    existing === undefined
      ? trimmedUrl !== '' && trimmedKey !== ''
      : trimmedUrl !== existing.url || trimmedKey !== '';
  const isSaving = createService.isPending || updateService.isPending;
  const canSave = dirty && (proven || !needsTest) && !isSaving;

  const runTest = () => {
    testService.mutate(
      { url: trimmedUrl, apiKey: trimmedKey },
      {
        onSuccess: (result) =>
          setTested({ url: trimmedUrl, apiKey: trimmedKey, result, error: null }),
        onError: (error) =>
          setTested({ url: trimmedUrl, apiKey: trimmedKey, result: null, error: error.message }),
      }
    );
  };

  const save = () => {
    const close = { onSuccess: () => onOpenChange(false) };
    if (existing) {
      updateService.mutate(
        {
          id: existing.id,
          data: { url: trimmedUrl, ...(trimmedKey ? { apiKey: trimmedKey } : {}) },
        },
        close
      );
      return;
    }
    createService.mutate({ serverId: server.id, url: trimmedUrl, apiKey: trimmedKey }, close);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {existing
              ? t('requests.dialog.titleEdit')
              : t('requests.dialog.titleLink', { server: server.name })}
          </DialogTitle>
          <DialogDescription>{t('requests.dialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="request-service-url">{t('requests.dialog.url')}</FieldLabel>
            <Input
              id="request-service-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://seerr.example.com"
              autoComplete="off"
              aria-describedby={TEST_RESULT_ID}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="request-service-key">{t('requests.dialog.apiKey')}</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="request-service-key"
                type={keyVisible ? 'text' : 'password'}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="off"
                aria-describedby={TEST_RESULT_ID}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  tabIndex={-1}
                  aria-label={keyVisible ? 'Hide password' : 'Show password'}
                  onClick={() => setKeyVisible((visible) => !visible)}
                >
                  {keyVisible ? <EyeOff /> : <Eye />}
                </InputGroupButton>
                <InputGroupButton
                  onClick={runTest}
                  disabled={!trimmedUrl || !trimmedKey || testService.isPending}
                >
                  {testService.isPending && <Loader2 className="animate-spin" />}
                  {testService.isPending ? t('requests.dialog.testing') : t('requests.dialog.test')}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription>
              {existing ? t('requests.dialog.apiKeyKeep') : t('requests.dialog.apiKeyHint')}
            </FieldDescription>
          </Field>

          <output id={TEST_RESULT_ID} aria-live="polite" className="block">
            <TestResult
              server={server}
              servers={servers}
              tested={tested}
              matchedHere={matchedHere}
            />
          </output>
        </div>

        <DialogFooter>
          {needsTest && !proven && (
            <span className="text-muted-foreground self-center text-xs">
              {t('requests.dialog.saveHint')}
            </span>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('requests.dialog.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TestResult({
  server,
  servers,
  tested,
  matchedHere,
}: {
  server: Server;
  servers: Server[] | undefined;
  tested: TestState | null;
  matchedHere: boolean;
}) {
  const { t } = useTranslation('settings');

  if (tested === null) return null;

  if (tested.error !== null) {
    return <p className="text-destructive text-sm">{tested.error}</p>;
  }

  if (tested.result === null) return null;

  if (matchedHere) {
    return (
      <p className="text-success text-sm">
        {t('requests.dialog.match', {
          title: tested.result.applicationTitle,
          version: shortVersion(tested.result.version),
          type: capitalise(tested.result.mediaServerType),
          server: server.name,
        })}
      </p>
    );
  }

  const other = servers?.find((candidate) => candidate.id === tested.result?.matchedServerId);

  return (
    <Alert variant="destructive">
      <AlertTitle>
        {other
          ? t('requests.dialog.mismatchOther', { other: other.name })
          : t('requests.dialog.mismatch')}
      </AlertTitle>
      <AlertDescription>
        {t('requests.dialog.mismatchIds', {
          remote: tested.result.remoteServerId,
          server: server.name,
          local: server.machineIdentifier ?? '—',
        })}
      </AlertDescription>
    </Alert>
  );
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
