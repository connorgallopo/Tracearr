import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface BindingDoorsProps {
  primaryLabel: string;
  primaryIcon?: ReactNode;
  onPrimary: () => void;
  pending: boolean;
  /** Off until something is worth sending; a dialog leaves it on. */
  disabled?: boolean;
  /** Left out where the only way on is the primary door. */
  secondaryLabel?: string;
  onSecondary?: () => void;
  helper?: string;
  /** What the left of the row says, which is whether anything is unsaved. */
  status?: ReactNode;
  /** Whatever sits left of the status, like a switch. */
  leading?: ReactNode;
  className?: string;
}

/** The row that ends a form: what is unsaved on the left, the ways out on the right. */
export function BindingDoors({
  primaryLabel,
  primaryIcon,
  pending,
  disabled,
  secondaryLabel,
  helper,
  status,
  onPrimary,
  onSecondary,
  leading,
  className,
}: BindingDoorsProps) {
  return (
    <div className={cn('@container/doors flex flex-col gap-2.5', className)}>
      <div className="flex flex-wrap items-center gap-2.5">
        {leading}
        {status}
        <div className="flex gap-2 @max-sm/doors:w-full @max-sm/doors:flex-col-reverse @sm/doors:ml-auto">
          {secondaryLabel !== undefined && (
            <Button type="button" variant="outline" onClick={onSecondary} disabled={pending}>
              {secondaryLabel}
            </Button>
          )}
          <Button type="button" onClick={onPrimary} disabled={pending || disabled === true}>
            {primaryIcon}
            {primaryLabel}
          </Button>
        </div>
      </div>
      {helper !== undefined && (
        <p className="text-muted-foreground text-xs leading-relaxed">{helper}</p>
      )}
    </div>
  );
}
