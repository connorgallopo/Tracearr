import { ChevronsUpDown, X } from 'lucide-react';
import type { Condition, ConditionField, Operator, RulesFilterOptions } from '@tracearr/shared';
import { fromMetricDistance, toMetricDistance, formatConditionFieldValue } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NumericInput } from '@/components/ui/numeric-input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  FIELD_DEFINITIONS,
  CATEGORY_LABELS,
  OPERATOR_LABELS,
  getFieldsByCategory,
  getDefaultOperatorForField,
  getDefaultValueForField,
  isArrayOperator,
  type FieldCategory,
} from '@/lib/rules';
import { useSettings } from '@/hooks/queries';

interface ConditionRowProps {
  condition: Condition;
  onChange: (condition: Condition) => void;
  onRemove: () => void;
  showRemove?: boolean;
  filterOptions?: RulesFilterOptions;
}

export function ConditionRow({
  condition,
  onChange,
  onRemove,
  showRemove = true,
  filterOptions,
}: ConditionRowProps) {
  const fieldDef = FIELD_DEFINITIONS[condition.field];
  const fieldsByCategory = getFieldsByCategory();
  const { data: settings } = useSettings();
  const unitSystem = settings?.unitSystem ?? 'metric';

  // Handle field change - reset operator and value
  const handleFieldChange = (newField: ConditionField) => {
    const newFieldDef = FIELD_DEFINITIONS[newField];
    // Build params based on field capabilities
    const params: {
      window_hours?: number;
      window_period?: 'day' | 'week' | 'month' | 'year';
      exclude_same_device?: boolean;
    } = {};
    if (newFieldDef.hasWindowHours) params.window_hours = 24;
    if (newFieldDef.hasWindowPeriod) params.window_period = 'month';
    if (newFieldDef.hasExcludeSameDevice) params.exclude_same_device = true;

    onChange({
      field: newField,
      operator: getDefaultOperatorForField(newField),
      value: getDefaultValueForField(newField),
      ...(Object.keys(params).length > 0 ? { params } : {}),
    });
  };

  // Handle operator change
  const handleOperatorChange = (newOperator: Operator) => {
    // If switching between array and non-array operators, adjust value
    const wasArray = isArrayOperator(condition.operator);
    const isNowArray = isArrayOperator(newOperator);

    let newValue = condition.value;
    if (wasArray && !isNowArray && Array.isArray(condition.value)) {
      newValue = condition.value[0] ?? getDefaultValueForField(condition.field);
    } else if (!wasArray && isNowArray && !Array.isArray(condition.value)) {
      newValue = condition.value ? [condition.value as string] : [];
    }

    onChange({
      ...condition,
      operator: newOperator,
      value: newValue,
    });
  };

  // Handle value change
  const handleValueChange = (newValue: Condition['value']) => {
    onChange({
      ...condition,
      value: newValue,
    });
  };

  // Handle window hours change
  const handleWindowHoursChange = (hours: number) => {
    onChange({
      ...condition,
      params: { ...condition.params, window_hours: hours },
    });
  };

  // Handle window period change
  const handleWindowPeriodChange = (period: 'day' | 'week' | 'month' | 'year') => {
    onChange({
      ...condition,
      params: { ...condition.params, window_period: period },
    });
  };

  // Handle exclude same device change
  const handleExcludeSameDeviceChange = (exclude: boolean) => {
    onChange({
      ...condition,
      params: { ...condition.params, exclude_same_device: exclude },
    });
  };

  return (
    <div className="flex items-start gap-2">
      {/* Field Selector */}
      <Select value={condition.field} onValueChange={handleFieldChange}>
        <SelectTrigger className="w-[200px]">
          <SelectValue placeholder="Select field" />
        </SelectTrigger>
        <SelectContent className="min-w-[240px]">
          {(Object.keys(fieldsByCategory) as FieldCategory[]).map((category) => {
            const fields = fieldsByCategory[category];
            if (fields.length === 0) return null;
            return (
              <SelectGroup key={category}>
                <SelectLabel>{CATEGORY_LABELS[category]}</SelectLabel>
                {fields.map((def) => (
                  <SelectItem key={def.field} value={def.field}>
                    {def.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            );
          })}
        </SelectContent>
      </Select>

      {/* Operator Selector */}
      <Select value={condition.operator} onValueChange={handleOperatorChange}>
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Operator" />
        </SelectTrigger>
        <SelectContent className="min-w-[180px]">
          {fieldDef.operators.map((op) => (
            <SelectItem key={op} value={op}>
              {OPERATOR_LABELS[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Value Input */}
      <div className="min-w-[140px] flex-1">
        <ValueInput
          fieldDef={fieldDef}
          value={condition.value}
          onChange={handleValueChange}
          isArrayOperator={isArrayOperator(condition.operator)}
          filterOptions={filterOptions}
          unitSystem={unitSystem}
        />
      </div>

      {/* Window Hours (for velocity fields) */}
      {fieldDef.hasWindowHours && (
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground text-sm whitespace-nowrap">in</span>
          <NumericInput
            className="w-16"
            min={1}
            max={168}
            value={condition.params?.window_hours ?? 24}
            onChange={handleWindowHoursChange}
          />
          <span className="text-muted-foreground text-sm">hrs</span>
        </div>
      )}

      {/* Window Period (for bandwidth/traffic fields) */}
      {fieldDef.hasWindowPeriod && (
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground text-sm whitespace-nowrap">per</span>
          <Select
            value={(condition.params?.window_period as string) ?? 'month'}
            onValueChange={handleWindowPeriodChange}
          >
            <SelectTrigger className="w-[100px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">Day</SelectItem>
              <SelectItem value="week">Week</SelectItem>
              <SelectItem value="month">Month</SelectItem>
              <SelectItem value="year">Year</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Exclude Same Device (for cross-session comparisons) */}
      {fieldDef.hasExcludeSameDevice && (
        <Tooltip>
          <TooltipTrigger asChild>
            <label className="flex h-10 cursor-pointer items-center gap-2 whitespace-nowrap">
              <Checkbox
                checked={condition.params?.exclude_same_device ?? true}
                onCheckedChange={handleExcludeSameDeviceChange}
              />
              <span className="text-muted-foreground text-sm">Unique devices</span>
            </label>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[240px]">
            When checked, only compares sessions from different physical devices. Uncheck to include
            all sessions regardless of device.
          </TooltipContent>
        </Tooltip>
      )}

      {/* Remove Button */}
      {showRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-destructive h-10 w-10 shrink-0"
          onClick={onRemove}
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

// Value input component that adapts based on field type
interface ValueInputProps {
  fieldDef: (typeof FIELD_DEFINITIONS)[ConditionField];
  value: Condition['value'];
  onChange: (value: Condition['value']) => void;
  isArrayOperator: boolean;
  filterOptions?: RulesFilterOptions;
  unitSystem: 'metric' | 'imperial';
}

// Get dynamic options for fields that need API data
function getDynamicOptions(
  field: ConditionField,
  filterOptions?: RulesFilterOptions
): { value: string; label: string; group?: string }[] | undefined {
  if (!filterOptions) return undefined;

  switch (field) {
    case 'country':
      return filterOptions.countries?.map((c) => ({
        value: c.code,
        label: c.name,
        group: c.hasSessions ? 'Recently Seen' : 'All Countries',
      }));
    case 'server_id':
      return filterOptions.servers?.map((s) => ({
        value: s.id,
        label: s.name,
      }));
    case 'user_id':
      return filterOptions.users?.map((u) => ({
        value: u.id,
        label: u.identityName || u.username,
      }));
    default:
      return undefined;
  }
}

function ValueInput({
  fieldDef,
  value,
  onChange,
  isArrayOperator: isArray,
  filterOptions,
  unitSystem,
}: ValueInputProps) {
  // Boolean
  if (fieldDef.valueType === 'boolean') {
    return (
      <div className="flex h-10 items-center">
        <Switch checked={value === true} onCheckedChange={(checked) => onChange(checked)} />
        <span className="text-muted-foreground ml-2 text-sm">{value === true ? 'Yes' : 'No'}</span>
      </div>
    );
  }

  // Select (single or multi based on operator)
  if (fieldDef.valueType === 'select' || fieldDef.valueType === 'multi-select') {
    // Use dynamic options if available, otherwise fall back to static options
    const dynamicOptions = getDynamicOptions(fieldDef.field, filterOptions);
    const options = dynamicOptions ?? fieldDef.options ?? [];

    if (isArray) {
      return (
        <GroupedMultiSelectInput
          options={options}
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={onChange}
          placeholder={fieldDef.placeholder ?? `Select ${fieldDef.label.toLowerCase()}...`}
        />
      );
    }

    const selectValue = Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
    return (
      <Select value={selectValue} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder={fieldDef.placeholder ?? 'Select...'} />
        </SelectTrigger>
        <SelectContent className="min-w-[200px]">
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  // Number
  if (fieldDef.valueType === 'number') {
    const numericValue = typeof value === 'number' ? value : 0;
    const converted = formatConditionFieldValue(numericValue, fieldDef.field, unitSystem);
    const needsConversion = Boolean(converted.unit);

    const displayUnit = converted.unit || fieldDef.unit;

    // Convert value for display (metric value from DB to user's preferred unit)
    let displayValue = value as number;
    if (needsConversion && typeof value === 'number') {
      displayValue = Math.round(fromMetricDistance(value, unitSystem));
    }

    // Handle value change with conversion back to metric
    const handleNumericChange = (inputValue: number) => {
      if (needsConversion) {
        // Convert display value back to metric for storage
        const metricValue = Math.round(toMetricDistance(inputValue, unitSystem));
        onChange(metricValue);
      } else {
        onChange(inputValue);
      }
    };

    return (
      <div className="flex items-center gap-1">
        <NumericInput
          min={fieldDef.min}
          max={fieldDef.max}
          step={fieldDef.step}
          value={displayValue}
          onChange={handleNumericChange}
        />
        {displayUnit && (
          <span className="text-muted-foreground text-sm whitespace-nowrap">{displayUnit}</span>
        )}
      </div>
    );
  }

  // Text or CIDR
  return (
    <Input
      type="text"
      placeholder={fieldDef.placeholder ?? ''}
      value={value as string}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// Multi-select with optional grouping support (uses Popover to stay open)
interface GroupedMultiSelectInputProps {
  options: { value: string; label: string; group?: string }[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}

function GroupedMultiSelectInput({
  options,
  value,
  onChange,
  placeholder,
}: GroupedMultiSelectInputProps) {
  const selectedLabels = value
    .map((v) => options.find((o) => o.value === v)?.label ?? v)
    .join(', ');

  const toggleOption = (optValue: string) => {
    if (value.includes(optValue)) {
      onChange(value.filter((v) => v !== optValue));
    } else {
      onChange([...value, optValue]);
    }
  };

  // Group options if they have group property
  const hasGroups = options.some((o) => o.group);
  const groupedOptions = hasGroups
    ? options.reduce<Record<string, (typeof options)[number][]>>((acc, opt) => {
        const group = opt.group || 'Other';
        if (!acc[group]) acc[group] = [];
        acc[group].push(opt);
        return acc;
      }, {})
    : null;

  const renderOption = (opt: { value: string; label: string }) => (
    <label
      key={opt.value}
      className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
    >
      <Checkbox
        checked={value.includes(opt.value)}
        onCheckedChange={() => toggleOption(opt.value)}
      />
      <span className="flex-1">{opt.label}</span>
    </label>
  );

  return (
    <Popover modal>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          className="h-10 w-full justify-between font-normal"
        >
          <span className={`truncate ${value.length === 0 ? 'text-muted-foreground' : ''}`}>
            {value.length === 0
              ? placeholder
              : value.length === 1
                ? selectedLabels
                : `${value.length} selected`}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[250px] p-0" align="start">
        <div className="max-h-[300px] overflow-y-auto p-1">
          {groupedOptions
            ? Object.entries(groupedOptions).map(([groupName, groupOptions]) => (
                <div key={groupName}>
                  <div className="bg-muted/50 text-muted-foreground mx-1 mt-1 rounded-sm px-2 py-1.5 text-xs font-medium tracking-wider uppercase first:mt-0">
                    {groupName}
                  </div>
                  {groupOptions.map(renderOption)}
                </div>
              ))
            : options.map(renderOption)}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default ConditionRow;
