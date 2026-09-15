import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { getBaseVersion, normalizeVersion, type ReleaseNotesFile } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { WhatsNewSections } from '@/lib/releaseNotes';
import { ReleaseSection } from './ReleaseSection';

const RELEASES_URL = 'https://github.com/connorgallopo/Tracearr/releases';

interface WhatsNewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'auto' | 'reopen';
  sections: WhatsNewSections;
  runningVersion: string;
  sinceVersion: string | null;
  latestVersion: string | null;
}

function GroupLabel({ children }: { children: string }) {
  return (
    <p className="text-muted-foreground px-6 pt-4 pb-1 text-xs font-medium tracking-wide uppercase">
      {children}
    </p>
  );
}

export function WhatsNewDialog({
  open,
  onOpenChange,
  mode,
  sections,
  runningVersion,
  sinceVersion,
  latestVersion,
}: WhatsNewDialogProps) {
  const { t } = useTranslation(['settings', 'common']);
  const contentRef = useRef<HTMLDivElement>(null);
  const version = `v${runningVersion}`;
  const description =
    mode === 'reopen'
      ? t('settings:whatsNew.reopenDescription', { version })
      : sinceVersion
        ? t('settings:whatsNew.installedSince', { version, since: `v${sinceVersion}` })
        : t('settings:whatsNew.installed', { version });
  const runningBase = getBaseVersion(runningVersion);
  const latestBase =
    latestVersion === null ? null : getBaseVersion(normalizeVersion(latestVersion));
  const isEmpty = sections.lead.length + sections.patches.length + sections.earlier.length === 0;

  const section = (notes: ReleaseNotesFile, defaultOpen: boolean) => (
    <ReleaseSection
      key={notes.version}
      notes={notes}
      defaultOpen={defaultOpen}
      installed={notes.version === runningBase}
      latest={notes.version === latestBase}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        className="flex max-h-[85dvh] flex-col gap-0 p-0 sm:max-w-2xl"
      >
        <DialogHeader className="gap-1 border-b px-6 pt-5 pr-12 pb-3 text-left">
          <DialogTitle>{t('settings:whatsNew.title')}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* Plain min-h-0 flex-1 on the root never scrolled: the viewport has to flex too. */}
        <ScrollArea className="flex min-h-0 flex-1 flex-col [&>[data-slot=scroll-area-viewport]]:min-h-0 [&>[data-slot=scroll-area-viewport]]:flex-1">
          {isEmpty && (
            <p className="text-muted-foreground px-6 py-8 text-center text-sm">
              {t('settings:whatsNew.empty')}
            </p>
          )}
          {sections.lead.map((notes, index) => section(notes, index === 0))}
          {sections.since && sections.patches.length > 0 && (
            <>
              <GroupLabel>
                {t('settings:whatsNew.since', { version: `v${sections.since}` })}
              </GroupLabel>
              {sections.patches.map((notes) => section(notes, false))}
            </>
          )}
          {sections.earlier.length > 0 && (
            <>
              <GroupLabel>{t('settings:whatsNew.earlier')}</GroupLabel>
              {sections.earlier.map((notes) => section(notes, false))}
            </>
          )}
        </ScrollArea>
        <DialogFooter className="border-t px-6 py-4 sm:justify-between">
          <Button variant="ghost" asChild>
            <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">
              {t('settings:whatsNew.allReleases')}
              <ExternalLink />
            </a>
          </Button>
          <Button onClick={() => onOpenChange(false)}>
            {mode === 'auto' ? t('settings:whatsNew.gotIt') : t('common:actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
