import * as React from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface NumericInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type'
> {
  value: number;
  onChange: (value: number) => void;
  /** Minimum allowed value (also used as fallback for empty input) */
  min?: number;
  /** Maximum allowed value */
  max?: number;
  /** Step increment for arrow keys */
  step?: number;
  /** Allow decimal values (default: false, integers only) */
  allowDecimals?: boolean;
}

/**
 * A controlled numeric input that works correctly in Firefox.
 *
 * Firefox's <input type="number"> doesn't allow clearing the field to type a new value.
 * This component uses type="text" with inputMode="numeric" to allow empty intermediate
 * states while still showing the numeric keyboard on mobile.
 *
 * @see https://github.com/facebook/react/issues/6900
 * @see https://css-tricks.com/finger-friendly-numerical-inputs-with-inputmode/
 */
const NumericInput = React.forwardRef<HTMLInputElement, NumericInputProps>(
  (
    { className, value, onChange, min, max, step: _step, allowDecimals = false, onBlur, ...props },
    ref
  ) => {
    // Track the display value as a string to allow empty intermediate states
    const [displayValue, setDisplayValue] = React.useState<string>(String(value));

    // Sync display value when external value changes
    React.useEffect(() => {
      setDisplayValue(String(value));
    }, [value]);

    const parseValue = (str: string): number => {
      const parsed = allowDecimals ? parseFloat(str) : parseInt(str, 10);
      if (isNaN(parsed)) {
        return min ?? 0;
      }
      // Clamp to min/max
      let result = parsed;
      if (min !== undefined && result < min) result = min;
      if (max !== undefined && result > max) result = max;
      return result;
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;

      // Allow empty string for intermediate state
      if (newValue === '') {
        setDisplayValue('');
        return;
      }

      // Allow minus sign at start for negative numbers (if min allows)
      if (newValue === '-' && (min === undefined || min < 0)) {
        setDisplayValue('-');
        return;
      }

      // Validate the input matches our pattern
      const pattern = allowDecimals ? /^-?\d*\.?\d*$/ : /^-?\d*$/;
      if (!pattern.test(newValue)) {
        return; // Reject invalid input
      }

      setDisplayValue(newValue);

      // Parse and emit if it's a valid number
      const parsed = allowDecimals ? parseFloat(newValue) : parseInt(newValue, 10);
      if (!isNaN(parsed)) {
        onChange(parsed);
      }
    };

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      // On blur, ensure we have a valid value
      const parsed = parseValue(displayValue);
      setDisplayValue(String(parsed));
      if (parsed !== value) {
        onChange(parsed);
      }
      onBlur?.(e);
    };

    return (
      <Input
        ref={ref}
        type="text"
        inputMode={allowDecimals ? 'decimal' : 'numeric'}
        pattern={allowDecimals ? '[0-9]*\\.?[0-9]*' : '[0-9]*'}
        // Inert on type="text", but kept on the DOM so a11y tooling and tests can read the bounds.
        min={min}
        max={max}
        className={cn(className)}
        value={displayValue}
        onChange={handleChange}
        onBlur={handleBlur}
        {...props}
      />
    );
  }
);
NumericInput.displayName = 'NumericInput';

export { NumericInput };
