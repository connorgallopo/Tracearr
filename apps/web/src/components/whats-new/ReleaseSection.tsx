import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ExternalLink } from 'lucide-react';
import {
  parseVersion,
  RELEASE_CHANGE_TYPES,
  type ReleaseChangeType,
  type ReleaseNotesFile,
} from '@tracearr/shared';
import { formatDate } from '@tracearr/translations';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

const ISSUES_URL = 'https://github.com/connorgallopo/Tracearr/issues';

const CHIP_CLASSES: Record<ReleaseChangeType, string> = {
  new: 'bg-success/15 text-success',
  improved: 'bg-primary/15 text-primary',
  fix: 'bg-warning/15 text-warning',
  security: 'bg-destructive/15 text-destructive',
  note: 'bg-secondary text-secondary-foreground',
};

const TYPE_LABEL_KEYS = {
  new: 'settings:whatsNew.types.new',
  improved: 'settings:whatsNew.types.improved',
  fix: 'settings:whatsNew.types.fix',
  security: 'settings:whatsNew.types.security',
  note: 'settings:whatsNew.types.note',
} as const satisfies Record<ReleaseChangeType, string>;

// Two no-break spaces glue a link to the last word, so a link never wraps onto a line by itself.
const LINK_GAP = '  ';

function withInlineCode(text: string): ReactNode[] {
  return text.split('`').map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">
        {part}
      </code>
    ) : (
      part
    )
  );
}

interface ReleaseSectionProps {
  notes: ReleaseNotesFile;
  defaultOpen: boolean;
  installed: boolean;
  latest: boolean;
}

export function ReleaseSection({ notes, defaultOpen, installed, latest }: ReleaseSectionProps) {
  const { t } = useTranslation(['settings']);
  const [open, setOpen] = useState(defaultOpen);
  const parsed = parseVersion(notes.version);
  const date = formatDate(new Date(`${notes.date}T00:00:00`));
  const changes = [...notes.changes].sort(
    (a, b) => RELEASE_CHANGE_TYPES.indexOf(a.type) - RELEASE_CHANGE_TYPES.indexOf(b.type)
  );
  const count = t('settings:whatsNew.changeCount', { count: changes.length });

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b last:border-b-0">
      <CollapsibleTrigger className="hover:bg-muted/40 flex w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 px-6 py-3 text-left">
        <ChevronRight
          className={cn(
            'text-muted-foreground size-4 shrink-0 transition-transform',
            open && 'rotate-90'
          )}
        />
        <span className="font-semibold tabular-nums">v{notes.version}</span>
        {installed && <Badge variant="secondary">{t('settings:whatsNew.installedBadge')}</Badge>}
        {latest && <Badge>{t('settings:whatsNew.latestBadge')}</Badge>}
        <span className="text-muted-foreground text-xs">
          {count}
          <span className="sm:hidden"> · {date}</span>
        </span>
        <span className="text-muted-foreground ml-auto hidden text-xs sm:inline">{date}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 px-6 pb-5">
        {notes.headline && (
          <div className="py-4 text-center">
            <p className="text-primary text-xs font-medium tracking-wide uppercase">
              {t('settings:whatsNew.series', { series: `${parsed.major}.${parsed.minor}` })}
            </p>
            <p className="mt-1.5 text-lg font-semibold text-balance">{notes.headline}</p>
          </div>
        )}
        {notes.highlights && (
          <div className="grid gap-3 sm:grid-cols-2">
            {notes.highlights.map((highlight) => (
              <div key={highlight.title} className="bg-card-raised rounded-lg border p-4">
                <h3 className="text-sm font-medium">{highlight.title}</h3>
                <p className="text-muted-foreground mt-1 max-w-prose text-sm leading-relaxed [overflow-wrap:anywhere]">
                  {withInlineCode(highlight.body)}
                </p>
                {highlight.docs && (
                  <a
                    href={highlight.docs}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary mt-2 inline-flex items-center gap-1 text-xs hover:underline"
                  >
                    {t('settings:whatsNew.docs')}
                    <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
        <ul className="space-y-2">
          {changes.map((change) => (
            <li
              key={change.text}
              className="sm:grid sm:grid-cols-[4.5rem_1fr] sm:items-start sm:gap-x-3"
            >
              <Badge
                className={cn(
                  'mr-2 sm:mt-px sm:mr-0 sm:justify-self-start',
                  CHIP_CLASSES[change.type]
                )}
              >
                {t(TYPE_LABEL_KEYS[change.type])}
              </Badge>
              <p className="inline min-w-0 text-sm leading-6 [overflow-wrap:anywhere] sm:block sm:leading-5">
                {withInlineCode(change.text)}
                {change.refs?.map((ref) => (
                  <span key={ref}>
                    {LINK_GAP}
                    <a
                      href={`${ISSUES_URL}/${ref.slice(1)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground text-xs"
                    >
                      {ref}
                    </a>
                  </span>
                ))}
                {change.docs && (
                  <span>
                    {LINK_GAP}
                    <a
                      href={change.docs}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary inline-flex items-center gap-0.5 text-xs whitespace-nowrap hover:underline"
                    >
                      {t('settings:whatsNew.docs')}
                      <ExternalLink className="size-3" />
                    </a>
                  </span>
                )}
              </p>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
