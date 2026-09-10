import type { ComponentProps } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** Render inside a TooltipProvider; callers usually already wrap a group of these. */
export function TooltipIconButton({
  label,
  icon: Icon,
  onClick,
  size = 'icon-sm',
  variant = 'ghost',
  iconClassName,
  disabled,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  size?: 'icon-xs' | 'icon-sm' | 'icon' | 'icon-lg';
  variant?: ComponentProps<typeof Button>['variant'];
  iconClassName?: string;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={variant}
          size={size}
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
        >
          <Icon className={iconClassName} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
