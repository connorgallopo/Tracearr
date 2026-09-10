import type { ReactNode } from 'react';
import { Loader2, Check, AlertCircle, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Field, FieldLabel, FieldDescription, FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { NumericInput } from '@/components/ui/numeric-input';
import {
  INPUT_GROUP_CONTROL,
  INPUT_GROUP_UNIT,
  InputGroup,
  InputGroupAddon,
} from '@/components/ui/input-group';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { SaveStatus } from '@/hooks/useDebouncedSave';

interface SaveStatusIndicatorProps {
  status: SaveStatus;
  className?: string;
}

export function SaveStatusIndicator({ status, className }: SaveStatusIndicatorProps) {
  if (status === 'idle') return null;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs',
        status === 'saving' && 'text-muted-foreground',
        status === 'saved' && 'text-success',
        status === 'error' && 'text-destructive',
        className
      )}
    >
      {status === 'saving' && (
        <>
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Saving...</span>
        </>
      )}
      {status === 'saved' && (
        <>
          <Check className="h-3 w-3" />
          <span>Saved</span>
        </>
      )}
      {status === 'error' && (
        <>
          <AlertCircle className="h-3 w-3" />
          <span>Error</span>
        </>
      )}
    </span>
  );
}

interface FieldHeaderProps {
  id: string;
  label: string;
  status: SaveStatus;
  labelClassName?: string;
}

function FieldHeader({ id, label, status, labelClassName }: FieldHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <FieldLabel htmlFor={id} className={labelClassName}>
        {label}
      </FieldLabel>
      <SaveStatusIndicator status={status} />
    </div>
  );
}

interface ErrorActionsProps {
  errorMessage: string;
  onRetry?: () => void;
  onReset?: () => void;
}

function ErrorActions({ errorMessage, onRetry, onReset }: ErrorActionsProps) {
  return (
    <div className="flex items-center justify-between">
      <FieldError>{errorMessage}</FieldError>
      <div className="flex gap-1">
        {onRetry && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRetry}
            className="h-6 px-2 text-xs"
          >
            Retry
          </Button>
        )}
        {onReset && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="h-6 px-2 text-xs"
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}

interface AutosaveFieldBaseProps {
  label: string;
  description?: string;
  status: SaveStatus;
  errorMessage?: string | null;
  onRetry?: () => void;
  onReset?: () => void;
  className?: string;
}

interface AutosaveTextFieldProps extends AutosaveFieldBaseProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'url' | 'email';
  disabled?: boolean;
  maxLength?: number;
  /** Rendered beside the input, e.g. a detect/generate action. */
  trailing?: ReactNode;
}

export function AutosaveTextField({
  id,
  label,
  description,
  value,
  onChange,
  placeholder,
  type = 'text',
  status,
  errorMessage,
  onRetry,
  onReset,
  disabled,
  maxLength,
  trailing,
  className,
}: AutosaveTextFieldProps) {
  const hasError = status === 'error';
  const input = (
    <Input
      id={id}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={maxLength}
      aria-invalid={hasError}
    />
  );

  return (
    <Field data-invalid={hasError} className={className}>
      <FieldHeader id={id} label={label} status={status} />
      {trailing ? (
        <div className="flex gap-2">
          {input}
          {trailing}
        </div>
      ) : (
        input
      )}
      {description && <FieldDescription>{description}</FieldDescription>}
      {hasError && errorMessage && (
        <ErrorActions errorMessage={errorMessage} onRetry={onRetry} onReset={onReset} />
      )}
    </Field>
  );
}

interface AutosaveSecretFieldProps extends AutosaveFieldBaseProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function AutosaveSecretField({
  id,
  label,
  description,
  value,
  onChange,
  placeholder,
  status,
  errorMessage,
  onRetry,
  onReset,
  disabled,
  className,
}: AutosaveSecretFieldProps) {
  const hasError = status === 'error';

  return (
    <Field data-invalid={hasError} className={className}>
      <FieldHeader id={id} label={label} status={status} />
      <PasswordInput
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={hasError}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      {hasError && errorMessage && (
        <ErrorActions errorMessage={errorMessage} onRetry={onRetry} onReset={onReset} />
      )}
    </Field>
  );
}

interface AutosaveNumberFieldProps extends AutosaveFieldBaseProps {
  id: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  suffix?: string;
}

export function AutosaveNumberField({
  id,
  label,
  description,
  value,
  onChange,
  min,
  max,
  step,
  status,
  errorMessage,
  onRetry,
  onReset,
  disabled,
  suffix,
  className,
}: AutosaveNumberFieldProps) {
  const hasError = status === 'error';

  return (
    <Field data-invalid={hasError} className={cn('max-w-sm', className)}>
      <FieldHeader id={id} label={label} status={status} />
      <InputGroup data-disabled={disabled || undefined}>
        <NumericInput
          id={id}
          value={value}
          onChange={onChange}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-invalid={hasError}
          data-slot="input-group-control"
          className={cn('flex-1', INPUT_GROUP_CONTROL)}
        />
        {suffix && (
          <InputGroupAddon align="inline-end" className={INPUT_GROUP_UNIT}>
            {suffix}
          </InputGroupAddon>
        )}
      </InputGroup>
      {description && <FieldDescription>{description}</FieldDescription>}
      {hasError && errorMessage && (
        <ErrorActions errorMessage={errorMessage} onRetry={onRetry} onReset={onReset} />
      )}
    </Field>
  );
}

interface SelectOption {
  value: string;
  label: string;
}

interface AutosaveSelectFieldProps extends AutosaveFieldBaseProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
}

export function AutosaveSelectField({
  id,
  label,
  description,
  value,
  onChange,
  options,
  placeholder,
  status,
  errorMessage,
  onRetry,
  onReset,
  disabled,
  className,
}: AutosaveSelectFieldProps) {
  const hasError = status === 'error';

  return (
    <Field data-invalid={hasError} className={cn('max-w-sm', className)}>
      <FieldHeader id={id} label={label} status={status} />
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} aria-invalid={hasError}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description && <FieldDescription>{description}</FieldDescription>}
      {hasError && errorMessage && (
        <ErrorActions errorMessage={errorMessage} onRetry={onRetry} onReset={onReset} />
      )}
    </Field>
  );
}

interface AutosaveSwitchFieldProps extends AutosaveFieldBaseProps {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function AutosaveSwitchField({
  id,
  label,
  description,
  checked,
  onChange,
  status,
  errorMessage,
  onRetry,
  onReset,
  disabled,
  className,
}: AutosaveSwitchFieldProps) {
  const hasError = status === 'error';

  return (
    <Field orientation="horizontal" data-invalid={hasError} className={className}>
      <div className="flex flex-1 flex-col gap-1">
        <FieldHeader id={id} label={label} status={status} labelClassName="cursor-pointer" />
        {description && <FieldDescription>{description}</FieldDescription>}
        {hasError && errorMessage && (
          <ErrorActions errorMessage={errorMessage} onRetry={onRetry} onReset={onReset} />
        )}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </Field>
  );
}

interface AutosaveTextareaFieldProps extends AutosaveFieldBaseProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
  rows?: number;
}

export function AutosaveTextareaField({
  id,
  label,
  description,
  value,
  onChange,
  placeholder,
  status,
  errorMessage,
  onRetry,
  onReset,
  disabled,
  maxLength,
  rows = 3,
  className,
}: AutosaveTextareaFieldProps) {
  const hasError = status === 'error';

  return (
    <Field data-invalid={hasError} className={className}>
      <FieldHeader id={id} label={label} status={status} />
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        rows={rows}
        aria-invalid={hasError}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      {hasError && errorMessage && (
        <ErrorActions errorMessage={errorMessage} onRetry={onRetry} onReset={onReset} />
      )}
    </Field>
  );
}
