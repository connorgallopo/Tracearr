import { useId } from 'react';
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
  const groupName = useId();

  return (
    <fieldset className="flex flex-wrap gap-2">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => {
        const isSelected = option.id === value;

        return (
          <label
            key={option.id}
            title={option.name}
            className={cn(
              'ring-offset-background has-[:focus-visible]:ring-ring relative size-8 rounded-md transition-transform hover:scale-105 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-offset-2',
              isSelected && 'ring-foreground scale-105 ring-2 ring-offset-2'
            )}
            style={{ backgroundColor: option.hex }}
          >
            <input
              type="radio"
              name={groupName}
              value={option.id}
              checked={isSelected}
              aria-label={option.name}
              onChange={() => {
                onChange(option.id);
              }}
              className="sr-only"
            />
            {isSelected && (
              <Check
                className="absolute inset-0 m-auto size-4 text-white drop-shadow-md"
                aria-hidden="true"
              />
            )}
          </label>
        );
      })}
    </fieldset>
  );
}
