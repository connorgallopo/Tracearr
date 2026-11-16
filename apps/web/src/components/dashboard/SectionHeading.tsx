import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SectionHeadingProps {
  icon: LucideIcon;
  title: string;
  /** Muted text after the title, e.g. the window the section covers */
  caption?: string;
  /** Trailing content: a count pill, a link */
  children?: ReactNode;
  /** Right-aligned controls; on a phone they wrap under the heading */
  actions?: ReactNode;
  className?: string;
}

/** The dashboard's section heading: accent icon, title, optional caption and trailing content. */
export function SectionHeading({
  icon: Icon,
  title,
  caption,
  children,
  actions,
  className,
}: SectionHeadingProps) {
  return (
    <div className={cn('mb-4 flex flex-wrap items-center gap-2', className)}>
      <Icon className="text-primary h-5 w-5" />
      <h2 className="text-base font-semibold">{title}</h2>
      {caption && <span className="text-muted-foreground text-xs">{caption}</span>}
      {children}
      {actions && <div className="ml-auto">{actions}</div>}
    </div>
  );
}
