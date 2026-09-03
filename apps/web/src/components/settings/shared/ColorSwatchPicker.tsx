import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ColorSwatchPicker({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: string; name: string; hex: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const selectedIndex = options.findIndex((option) => option.id === value);

  const move = (delta: number) => {
    if (options.length === 0) return;
    const from = selectedIndex === -1 ? 0 : selectedIndex;
    const next = options[(from + delta + options.length) % options.length];
    if (next) onChange(next.id);
  };

  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((option, index) => {
        const isSelected = option.id === value;

        return (
          <button
            key={option.id}
            type="button"
            // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- swatch is a colored button, not a labelable input
            role="radio"
            aria-checked={isSelected}
            aria-label={option.name}
            // One stop in the tab order; the arrow keys move between swatches.
            tabIndex={isSelected || (selectedIndex === -1 && index === 0) ? 0 : -1}
            onClick={() => {
              onChange(option.id);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                move(1);
              }
              if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                move(-1);
              }
            }}
            className={cn(
              'ring-offset-background focus-visible:ring-ring relative size-8 rounded-md transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
              isSelected && 'ring-foreground scale-105 ring-2 ring-offset-2'
            )}
            style={{ backgroundColor: option.hex }}
          >
            {isSelected && (
              <Check
                className="absolute inset-0 m-auto size-4 text-white drop-shadow-md"
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
