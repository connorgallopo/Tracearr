import { useId, useState, type ReactNode } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { FilterField } from './fields/filter-field';
import { activeFilterChips, countActiveFilters, setFilterValue } from './filter-utils';
import type { FilterDescriptor, FilterState, FilterValue } from './types';

export interface FilterBarLabels {
  trigger: string;
  panelTitle: string;
  clearAll: string;
  done: string;
  removeFilter: (label: string) => string;
}

export interface FilterBarProps<S extends FilterState> {
  descriptors: FilterDescriptor[];
  value: S;
  onChange: (next: S) => void;
  /** "Clear all" resolves to this, so a consumer keeps one DEFAULTS constant. */
  defaults: S;
  labels: FilterBarLabels;
  className?: string;
  /** Extra controls placed in the bar after the filter trigger. */
  children?: ReactNode;
}

function FilterChip({
  label,
  value,
  removeLabel,
  onRemove,
}: {
  label: string;
  value: string;
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <Badge variant="secondary" className="h-7 gap-1.5 pr-1.5 pl-2.5 text-xs font-normal">
      <span className="text-muted-foreground">{value ? `${label}:` : label}</span>
      {value && <span className="max-w-[160px] truncate font-medium">{value}</span>}
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="hover:bg-muted-foreground/20 ml-0.5 rounded-full p-0.5"
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  );
}

export function FilterBar<S extends FilterState>({
  descriptors,
  value,
  onChange,
  defaults,
  labels,
  className,
  children,
}: FilterBarProps<S>) {
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  const baseId = useId();

  const inlineDescriptors = descriptors.filter((descriptor) => descriptor.inline);
  const panelDescriptors = descriptors.filter((descriptor) => !descriptor.inline);

  const panelCount = countActiveFilters(panelDescriptors, value);
  const chips = activeFilterChips(descriptors, value);
  // An inline field draws no chip of its own, but Clear all still has something to clear.
  const anyActive = countActiveFilters(descriptors, value) > 0;

  const update = (key: string, next: FilterValue) => onChange(setFilterValue(value, key, next));

  const renderField = (descriptor: FilterDescriptor) => (
    <FilterField
      descriptor={descriptor}
      value={value[descriptor.key]}
      onChange={(next) => update(descriptor.key, next)}
      id={`${baseId}-${descriptor.key}`}
    />
  );

  const panelFields = (
    <div className="space-y-4">
      {panelDescriptors.map((descriptor) =>
        descriptor.kind === 'boolean' ? (
          <div key={descriptor.key}>{renderField(descriptor)}</div>
        ) : (
          <div key={descriptor.key} className="space-y-1.5">
            <Label
              htmlFor={`${baseId}-${descriptor.key}`}
              className="text-muted-foreground text-xs font-normal"
            >
              {descriptor.label}
            </Label>
            {renderField(descriptor)}
          </div>
        )
      )}
    </div>
  );

  const trigger = (
    <Button variant="outline" size="sm" className="h-9 gap-1.5">
      <SlidersHorizontal className="h-3.5 w-3.5" />
      {labels.trigger}
      {panelCount > 0 && (
        <Badge variant="secondary" className="ml-1 h-5 px-1.5">
          {panelCount}
        </Badge>
      )}
    </Button>
  );

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-center gap-2.5">
        {inlineDescriptors.map((descriptor) => (
          <div key={descriptor.key} className={descriptor.className}>
            {renderField(descriptor)}
          </div>
        ))}

        {panelDescriptors.length > 0 &&
          (isMobile ? (
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger asChild>{trigger}</SheetTrigger>
              <SheetContent side="right" className="overflow-y-auto">
                <SheetHeader>
                  <SheetTitle>{labels.panelTitle}</SheetTitle>
                </SheetHeader>
                <div className="px-4">{panelFields}</div>
                <SheetFooter>
                  <Button variant="ghost" onClick={() => setSheetOpen(false)}>
                    {labels.done}
                  </Button>
                </SheetFooter>
              </SheetContent>
            </Sheet>
          ) : (
            <Popover>
              <PopoverTrigger asChild>{trigger}</PopoverTrigger>
              <PopoverContent
                align="start"
                className="max-h-[var(--radix-popover-content-available-height)] w-72 overflow-y-auto"
              >
                {panelFields}
              </PopoverContent>
            </Popover>
          ))}

        {children}
      </div>

      {anyActive && (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <FilterChip
              key={chip.key}
              label={chip.label}
              value={chip.value}
              removeLabel={labels.removeFilter(chip.label)}
              onRemove={() => update(chip.key, undefined)}
            />
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-7 gap-1 px-2 text-xs"
            onClick={() => onChange(defaults)}
          >
            <X className="h-3.5 w-3.5" />
            {labels.clearAll}
          </Button>
        </div>
      )}
    </div>
  );
}
