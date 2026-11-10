import { useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import type { JellyfinEmbyServerType, ServerConnectionStatus } from '@tracearr/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const ISSUE_KEYS = {
  blocked: 'servers.realtimeDialog.issueBlocked',
  restart_required: 'servers.realtimeDialog.issueRestartRequired',
  malfunctioned: 'servers.realtimeDialog.issueMalfunctioned',
} as const;

const PLUGIN_GUIDES = {
  jellyfin: {
    description: 'servers.realtimeDialog.jellyfinDescription',
    updateDescription: 'servers.realtimeDialog.jellyfinUpdateDescription',
    steps: [
      'servers.realtimeDialog.jellyfinStep1',
      'servers.realtimeDialog.jellyfinStep2',
      'servers.realtimeDialog.jellyfinStep3',
      'servers.realtimeDialog.jellyfinStep4',
    ],
    repoUrl: 'servers.realtimeDialog.jellyfinRepoUrl',
  },
  emby: {
    description: 'servers.realtimeDialog.embyDescription',
    updateDescription: 'servers.realtimeDialog.embyUpdateDescription',
    steps: [
      'servers.realtimeDialog.embyStep1',
      'servers.realtimeDialog.embyStep2',
      'servers.realtimeDialog.embyStep3',
    ],
    repoUrl: null,
  },
} as const;

const BOLD = { strong: <strong /> };

export function RealtimeSetupDialog({
  serverType,
  open,
  onClose,
  mode = 'setup',
  connectionStatus,
}: {
  serverType: JellyfinEmbyServerType;
  open: boolean;
  onClose: () => void;
  mode?: 'setup' | 'update';
  connectionStatus?: ServerConnectionStatus;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const guide = PLUGIN_GUIDES[serverType];
  const repoUrl = guide.repoUrl && t(guide.repoUrl);
  const repoUrlRef = useRef<HTMLElement>(null);
  const issueKey =
    connectionStatus?.pluginIssue && connectionStatus.pluginIssue in ISSUE_KEYS
      ? ISSUE_KEYS[connectionStatus.pluginIssue as keyof typeof ISSUE_KEYS]
      : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === 'update'
              ? t('servers.realtimeDialog.updateTitle')
              : t('servers.realtimeDialog.title')}
          </DialogTitle>
          <DialogDescription>
            {t(mode === 'update' ? guide.updateDescription : guide.description)}
          </DialogDescription>
        </DialogHeader>

        <div className="text-muted-foreground space-y-3 text-sm">
          {issueKey && (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertDescription>
                <span>{t(issueKey)}</span>
                {connectionStatus?.error && (
                  <code className="text-muted-foreground block truncate text-xs">
                    {connectionStatus.error}
                  </code>
                )}
              </AlertDescription>
            </Alert>
          )}
          <ol className="list-decimal space-y-2 pl-4">
            {guide.steps.map((step) => (
              <li key={step}>
                <Trans t={t} i18nKey={step} components={BOLD} />
              </li>
            ))}
          </ol>
          {repoUrl && (
            <div className="space-y-1">
              <p className="text-foreground text-xs font-medium">
                {t('servers.realtimeDialog.repositoryUrl')}
              </p>
              <div className="flex items-center gap-2">
                <code
                  ref={repoUrlRef}
                  className="bg-muted flex-1 truncate rounded px-2 py-1 text-xs"
                >
                  {repoUrl}
                </code>
                <CopyButton
                  value={repoUrl}
                  label={t('servers.realtimeDialog.copyUrl')}
                  selectTarget={() => repoUrlRef.current}
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                />
              </div>
            </div>
          )}
          <p className="text-xs">{t('servers.realtimeDialog.autoDetectNote')}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common:actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
