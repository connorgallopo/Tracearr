import { Children, isValidElement, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { LucideIcon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export function ShelfSkeleton({
  title,
  aspect = 'poster',
}: {
  title: string;
  aspect?: 'poster' | 'square';
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-[16px] font-semibold tracking-[-0.01em]">{title}</h2>
      <div className="flex gap-4 overflow-x-hidden">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="w-[138px] shrink-0 space-y-1.5">
            <Skeleton
              className={cn(
                'w-full rounded-md',
                aspect === 'square' ? 'aspect-square' : 'aspect-[2/3]'
              )}
            />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

interface ShelfProps {
  id: string;
  title: string;
  /** Accent icon before the heading, the way dashboard sections carry one */
  icon?: LucideIcon;
  /** Muted secondary text next to the heading, e.g. "deduped across servers". */
  caption?: string;
  /** When provided (with viewAllLabel), renders a link at the end of the shelf head. */
  viewAllHref?: string;
  /**
   * Caller-supplied, already-translated label for the view-all link (e.g.
   * "View all") - kept caller-supplied rather than adding a Shelf-owned i18n
   * key, since the label text belongs to the page that knows what "all"
   * means for this shelf.
   */
  viewAllLabel?: string;
  /** Per-item slot width; ranked shelves widen it so the rank lane doesn't shrink the poster. */
  itemWidthClassName?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Labelled region with list semantics (spec a11y requirement): a heading
 * tied to the section via aria-labelledby, and each poster card wrapped in
 * a real <li> inside a <ul role="list">.
 */
export function Shelf({
  id,
  title,
  icon: Icon,
  caption,
  viewAllHref,
  viewAllLabel,
  itemWidthClassName,
  children,
  className,
}: ShelfProps) {
  const headingId = `${id}-heading`;
  const items = Children.toArray(children);

  return (
    <section aria-labelledby={headingId} className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2">
        {Icon && <Icon className="text-primary h-5 w-5" />}
        <h2 id={headingId} className="text-[16px] font-semibold tracking-[-0.01em]">
          {title}
        </h2>
        {caption && <span className="text-muted-foreground ml-1 text-xs">{caption}</span>}
        {viewAllHref && viewAllLabel && (
          <Link to={viewAllHref} className="text-primary ml-auto text-xs font-medium">
            {viewAllLabel} <span aria-hidden="true">→</span>
          </Link>
        )}
      </div>
      {/* overflow-x: auto clips both the top edge (it forces overflow-y to auto
          too) and the inline-start edge, so the card hover lift's -translate-y
          and its shadow (PosterCard) need padding on both axes to stay inside
          this row's content box: pt-3 for the top, pl-1.5 for the left. The
          matching -ml-1.5 cancels pl-1.5's visual shift so the row still lines
          up with the heading above it. */}
      <ul
        // oxlint-disable-next-line jsx-a11y/no-redundant-roles -- Safari drops list semantics once Tailwind resets list-style
        role="list"
        className="-ml-1.5 flex snap-x snap-proximity scrollbar-thin gap-4 overflow-x-auto pt-3 pb-2 pl-1.5"
      >
        {items.map((item, index) => (
          <li
            key={isValidElement(item) && item.key != null ? item.key : index}
            className={cn(itemWidthClassName ?? 'w-[138px]', 'shrink-0 snap-start')}
          >
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}
