import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';

const ZONES: readonly string[] = Intl.supportedValuesOf('timeZone');
const OPTIONS: ComboboxOption[] = ZONES.map((zone) => ({
  value: zone,
  label: zone,
  group: zone.includes('/') ? zone.slice(0, zone.indexOf('/')) : zone,
}));

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A stored alias the browser does not list (US/Eastern) is kept as its own option, so the picker never blanks a saved value. */
export function TimezoneSelect({
  value,
  onChange,
  id,
  'aria-labelledby': labelledBy,
  disabled,
}: {
  value: string;
  onChange: (zone: string) => void;
  id?: string;
  'aria-labelledby'?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation('settings');
  const options = useMemo(
    () =>
      ZONES.includes(value)
        ? OPTIONS
        : [{ value, label: value, group: t('shared.timezone.other') }, ...OPTIONS],
    [value, t]
  );
  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={options}
      placeholder={t('shared.timezone.placeholder')}
      searchPlaceholder={t('shared.timezone.search')}
      emptyText={t('shared.timezone.empty')}
      id={id}
      aria-labelledby={labelledBy}
      disabled={disabled}
      className="max-w-sm"
      contentClassName="w-80"
    />
  );
}
