import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ShieldCheck } from 'lucide-react';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
import { useSettings } from '@/hooks/queries/useSettings';
import {
  describeTemplate,
  templateIcon,
  templateName,
  type DescribeFragment,
  type DescribeRefs,
} from '@/lib/automations';
import { cn } from '@/lib/utils';
import type { AutomationTemplate } from '@/lib/api';

/** A card names no ids of its own: every value it shows is a default or a placeholder. */
const NO_REFS: DescribeRefs = {};

/** The clause an input wrote, marked as the reader's own wherever the clauses are lifted. */
const SLOT = 'text-foreground bg-primary/10 rounded-sm px-0.5';

/** The clause the focused field wrote, lifted out of the rest of the sentence. */
const HIGHLIGHT =
  'text-foreground bg-primary/15 decoration-primary rounded-sm px-0.5 underline decoration-1 underline-offset-2';

interface TemplateSentenceProps {
  fragments: readonly DescribeFragment[];
  /** Lifts the clauses out of the connective words, as the binding form's panel does. */
  clauses?: boolean;
  /** The input whose clause is lit while its field has focus. */
  highlightKey?: string | null;
  className?: string;
}

/** The sentence as text, with the clauses the reader's own answers wrote standing out. */
export function TemplateSentence({
  fragments,
  clauses,
  highlightKey,
  className,
}: TemplateSentenceProps) {
  return (
    <>
      {fragments.map((fragment, index) => {
        const key = `${fragment.nodeId ?? 'text'}:${index}`;
        const lit = highlightKey != null && (fragment.inputKeys?.includes(highlightKey) ?? false);
        const owned = clauses === true && (fragment.inputKeys?.length ?? 0) > 0;
        return (
          <span
            key={key}
            className={cn(
              clauses && fragment.nodeId !== null && 'text-foreground',
              owned && SLOT,
              lit && HIGHLIGHT,
              className
            )}
          >
            {fragment.text}{' '}
          </span>
        );
      })}
    </>
  );
}

/** Every state a row can be in, here rather than at a call site that can forget them. */
const ROW_STATES =
  'hover:border-primary/40 hover:bg-accent/40 active:bg-accent/60 group-data-[selected=true]:border-primary/40 group-data-[selected=true]:bg-accent/40';

interface GalleryRowProps {
  icon: ReactElement;
  title: string;
  description: ReactNode;
  meta?: ReactNode;
  /** The two rows that are doors rather than ready-made automations. */
  dashed?: boolean;
  onSelect?: () => void;
  className?: string;
}

/** One row of the gallery: icon, name, what it does, and where it came from. */
export function GalleryRow({
  icon,
  title,
  description,
  meta,
  dashed,
  onSelect,
  className,
}: GalleryRowProps) {
  const body = (
    <>
      <ItemMedia variant="icon" className={cn(dashed && 'bg-muted/60 border-dashed')}>
        {icon}
      </ItemMedia>
      <ItemContent className="gap-0.5">
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription className="text-dense line-clamp-none text-pretty">
          {description}
        </ItemDescription>
        {meta && (
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            {meta}
          </div>
        )}
      </ItemContent>
      <ChevronRight className="text-muted-foreground size-4 shrink-0 self-center opacity-0 transition-opacity group-hover/item:opacity-100 group-data-[selected=true]:opacity-100 max-sm:opacity-60" />
    </>
  );

  // The gallery's rows are opened by the CommandItem above them, so the states
  // belong to every row rather than to the ones that carry their own handler.
  const classes = cn(
    'bg-card-raised w-full items-start gap-3 px-3 py-2.5 text-left',
    ROW_STATES,
    className
  );

  if (!onSelect) {
    return (
      <Item variant="outline" size="sm" className={classes}>
        {body}
      </Item>
    );
  }

  return (
    <Item asChild variant="outline" size="sm" className={classes}>
      <button type="button" onClick={onSelect}>
        {body}
      </button>
    </Item>
  );
}

interface TemplateCardProps {
  template: AutomationTemplate;
  /** The gallery says where every card came from; the empty state's four are all built in. */
  showOrigin?: boolean;
  onSelect?: () => void;
  className?: string;
}

/** A ready-made automation, in the gallery and on the empty page alike. */
export function TemplateCard({
  template,
  showOrigin = true,
  onSelect,
  className,
}: TemplateCardProps) {
  const { t } = useTranslation('pages');
  const { data: settings } = useSettings();
  const fragments = describeTemplate(
    template.version,
    {},
    NO_REFS,
    t,
    settings?.unitSystem ?? 'metric'
  );

  return (
    <GalleryRow
      icon={templateIcon(template.version.definition)}
      title={templateName(t, template)}
      description={<TemplateSentence fragments={fragments} />}
      meta={
        <>
          <span className="text-foreground font-medium">
            {t(`automations.gallery.kind.${template.kind}`)}
          </span>
          {showOrigin && template.builtin && (
            <>
              <span aria-hidden className="opacity-50">
                ·
              </span>
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="size-3" />
                {t('automations.gallery.builtin')}
              </span>
            </>
          )}
        </>
      }
      onSelect={onSelect}
      className={className}
    />
  );
}
