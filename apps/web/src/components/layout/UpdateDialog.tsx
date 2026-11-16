import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, ArrowRight, Terminal, Package, Sparkles, TriangleAlert } from 'lucide-react';
import type { VersionInfo } from '@tracearr/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: VersionInfo;
}

/**
 * Dialog showing update details including version info, type, and release notes
 */
export function UpdateDialog({ open, onOpenChange, version }: UpdateDialogProps) {
  const { t } = useTranslation(['settings', 'common']);
  const { current, latest } = version;

  // Determine update type label
  const updateType = useMemo(() => {
    if (!latest) return null;

    // Current is beta, latest is stable of same base version
    if (current.isPrerelease && !latest.isPrerelease) {
      return {
        label: t('settings:update.stableRelease'),
        variant: 'default' as const,
        icon: Sparkles,
      };
    }

    // Current is beta, latest is newer beta
    if (current.isPrerelease && latest.isPrerelease) {
      return {
        label: t('settings:update.betaUpdate'),
        variant: 'secondary' as const,
        icon: Package,
      };
    }

    // Current is stable, latest is newer stable
    return { label: t('settings:update.newVersion'), variant: 'default' as const, icon: Sparkles };
  }, [current, latest, t]);

  // Format the docker pull command
  const dockerCommand = useMemo(() => {
    if (!latest) return '';

    // Check if user is running supervised image (tag starts with "supervised-")
    const isSupervised = current.tag?.startsWith('supervised-') ?? false;

    // Determine the appropriate tag based on image type and release channel
    let tag: string;
    if (isSupervised) {
      tag = latest.isPrerelease ? 'supervised-next' : 'supervised';
    } else {
      tag = latest.isPrerelease ? 'next' : 'latest';
    }

    return `docker pull ghcr.io/connorgallopo/tracearr:${tag}`;
  }, [current.tag, latest]);

  if (!latest || !updateType) return null;

  const currentDisplay = current.tag ?? `v${current.version}`;
  const latestDisplay = latest.tag;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle className="flex items-center gap-2">
              <updateType.icon className="text-success h-5 w-5" />
              {t('settings:update.title')}
            </DialogTitle>
            <Badge variant={updateType.variant} className="text-xs">
              {updateType.label}
            </Badge>
          </div>
          <DialogDescription className="flex items-center gap-2 pt-1">
            <span className="text-muted-foreground">{currentDisplay}</span>
            <ArrowRight className="text-muted-foreground h-3 w-3" />
            <span className="text-success font-medium">{latestDisplay}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Release name if different from tag */}
          {latest.releaseName && latest.releaseName !== latest.tag && (
            <div className="text-sm font-medium">{latest.releaseName}</div>
          )}

          {latest.upgradeWarnings.length > 0 && (
            <Alert variant="warning">
              <TriangleAlert />
              <AlertTitle>{t('settings:update.beforeUpdating')}</AlertTitle>
              <AlertDescription>
                <ul className="space-y-1">
                  {latest.upgradeWarnings.map((warning) => (
                    <li key={warning.version}>
                      <span className="font-medium">v{warning.version}</span>: {warning.text}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {/* Release notes */}
          {latest.releaseNotes && (
            <div className="space-y-2">
              <div className="text-foreground text-sm font-semibold">
                {t('settings:update.releaseNotes')}
              </div>
              <ScrollArea className="h-48 rounded-md border p-3">
                <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
                  <pre className="font-sans text-sm leading-relaxed whitespace-pre-wrap">
                    {latest.releaseNotes}
                  </pre>
                </div>
              </ScrollArea>
            </div>
          )}

          {/* Update command */}
          <div className="space-y-2">
            <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t('settings:update.updateCommand')}
            </div>
            <div className="bg-muted flex items-center gap-2 rounded-md p-3 font-mono text-sm">
              <Terminal className="text-muted-foreground h-4 w-4 shrink-0" />
              <code className="flex-1 select-all">{dockerCommand}</code>
            </div>
            <p className="text-muted-foreground text-xs">{t('settings:update.pullInstructions')}</p>
          </div>

          {/* Action buttons */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common:actions.later')}
            </Button>
            <Button asChild className="gap-2">
              <a href={latest.releaseUrl} target="_blank" rel="noopener noreferrer">
                {t('common:actions.viewOnGithub')}
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
