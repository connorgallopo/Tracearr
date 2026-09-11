import * as React from 'react';
import { format } from 'date-fns';
import { CalendarIcon } from 'lucide-react';
import type { DateRange } from 'react-day-picker';

import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export type TimeRangePeriod = 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';

export interface TimeRangeValue {
  period: TimeRangePeriod;
  startDate?: Date;
  endDate?: Date;
}

interface TimeRangePickerProps {
  value: TimeRangeValue;
  onChange: (value: TimeRangeValue) => void;
  className?: string;
}

const PRESETS: { value: TimeRangePeriod; label: string }[] = [
  { value: 'week', label: '7d' },
  { value: 'month', label: '30d' },
  { value: 'year', label: '1y' },
  { value: 'all', label: 'All' },
];

export function TimeRangePicker({ value, onChange, className }: TimeRangePickerProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [tempRange, setTempRange] = React.useState<DateRange | undefined>(undefined);

  // Sync tempRange when popover opens or value changes
  React.useEffect(() => {
    if (isOpen && value.startDate && value.endDate) {
      setTempRange({ from: value.startDate, to: value.endDate });
    } else if (isOpen && !value.startDate && !value.endDate) {
      setTempRange(undefined);
    }
  }, [isOpen, value.startDate, value.endDate]);

  const handlePresetClick = (period: TimeRangePeriod) => {
    onChange({ period, startDate: undefined, endDate: undefined });
  };

  const handleCustomApply = () => {
    if (tempRange?.from && tempRange?.to) {
      onChange({
        period: 'custom',
        startDate: tempRange.from,
        endDate: tempRange.to,
      });
      setIsOpen(false);
    }
  };

  const formatDateRange = () => {
    if (value.startDate && value.endDate) {
      return `${format(value.startDate, 'MMM d')} - ${format(value.endDate, 'MMM d, yyyy')}`;
    }
    return 'Custom';
  };

  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={value.period}
      // 'custom' is committed by Apply, not by opening the popover
      onValueChange={(next) => {
        if (next && next !== 'custom') handlePresetClick(next as TimeRangePeriod);
      }}
      className={className}
    >
      {PRESETS.map((preset) => (
        <ToggleGroupItem key={preset.value} value={preset.value}>
          {preset.label}
        </ToggleGroupItem>
      ))}

      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <ToggleGroupItem value="custom">
            <CalendarIcon />
            {value.period === 'custom' ? formatDateRange() : 'Custom'}
          </ToggleGroupItem>
        </PopoverTrigger>
        {/* z-[1100]: this picker sits over the Leaflet map, whose own controls
            reach z-1000, so the default z-50 would render underneath them */}
        <PopoverContent className="z-[1100] w-auto p-0" align="end">
          <div className="p-3">
            <Calendar
              mode="range"
              defaultMonth={tempRange?.from}
              selected={tempRange}
              onSelect={setTempRange}
              numberOfMonths={2}
              disabled={{ after: new Date() }}
            />
            <div className="mt-3 flex items-center justify-end gap-2 border-t pt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setTempRange(undefined);
                  setIsOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleCustomApply}
                disabled={!tempRange?.from || !tempRange?.to}
              >
                Apply
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </ToggleGroup>
  );
}
