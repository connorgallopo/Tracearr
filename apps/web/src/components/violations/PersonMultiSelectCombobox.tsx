/**
 * Multi-select searchable combobox for filtering violations by person
 * (identity). Follows the Command + Popover checkbox-item recipe used by
 * the shared MultiSelectList, but the trigger reuses SelectTrigger's own classes
 * (border/background/height/radius) so it sits flush with the severity and
 * status Select filters beside it on the Violations page.
 *
 * Search is server-side (see useUsers `search` param) rather than filtering
 * only the loaded page of options, since the roster can exceed the page size
 * fetched for the picker. Typing is debounced before it's forwarded via
 * `onSearchChange` so it doesn't fire a request per keystroke; the debounce
 * only delays a callback prop, it does not perform data fetching itself.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronsUpDown, X } from 'lucide-react';
import type { ServerUserWithIdentity } from '@tracearr/shared';
import { cn } from '@/lib/utils';
import { MultiSelectList } from '@/components/ui/multi-select';
import { selectTriggerClasses } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getAvatarUrl, rosterPersonName } from '@/components/users/utils';
import { summarizePersonSelection } from './personFilterSummary';

const SEARCH_DEBOUNCE_MS = 300;

interface PersonMultiSelectComboboxProps {
  value: string[];
  onChange: (userIds: string[]) => void;
  options: ServerUserWithIdentity[];
  onSearchChange?: (search: string) => void;
  isLoading?: boolean;
  isError?: boolean;
  allLabel: string;
  countLabel: (count: number) => string;
  searchPlaceholder: string;
  emptyMessage: string;
  errorMessage: string;
  loadingMessage: string;
  triggerId?: string;
  className?: string;
  // Resolves a display name for a selected id that isn't in the currently
  // loaded (search-scoped) options page, so the trigger summary can still
  // show a real name instead of falling back to the count label.
  resolveExtraName?: (id: string) => string | undefined;
}

export function PersonMultiSelectCombobox({
  value,
  onChange,
  options,
  onSearchChange,
  isLoading = false,
  isError = false,
  allLabel,
  countLabel,
  searchPlaceholder,
  emptyMessage,
  errorMessage,
  loadingMessage,
  triggerId,
  className,
  resolveExtraName,
}: PersonMultiSelectComboboxProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!onSearchChange) return;
    const handle = setTimeout(() => onSearchChange(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search, onSearchChange]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of options) {
      map.set(option.userId, rosterPersonName(option));
    }
    return map;
  }, [options]);

  const summary = summarizePersonSelection(
    value,
    (id) => nameById.get(id) ?? resolveExtraName?.(id),
    allLabel,
    countLabel
  );

  const toggle = (userId: string) => {
    onChange(value.includes(userId) ? value.filter((id) => id !== userId) : [...value, userId]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={triggerId}
          role="combobox"
          aria-expanded={open}
          className={cn(selectTriggerClasses, 'w-48', className)}
        >
          <span className="truncate">{summary}</span>
          <div className="flex items-center gap-1">
            {value.length > 0 && (
              <span
                role="button"
                tabIndex={-1}
                className="text-muted-foreground hover:text-foreground rounded p-0.5"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange([]);
                }}
              >
                <X className="h-3.5 w-3.5" />
                <span className="sr-only">{t('actions.clear')}</span>
              </span>
            )}
            <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <MultiSelectList
          options={options.map((option) => ({
            value: option.userId,
            label: rosterPersonName(option),
            icon: (
              <Avatar className="h-5 w-5">
                <AvatarImage
                  src={getAvatarUrl(option.thumbServerId, option.thumbUrl, 40) ?? undefined}
                />
                <AvatarFallback className="text-xs">
                  {rosterPersonName(option)[0]?.toUpperCase() ?? '?'}
                </AvatarFallback>
              </Avatar>
            ),
          }))}
          value={value}
          onToggle={toggle}
          onSearchChange={setSearch}
          searchPlaceholder={searchPlaceholder}
          emptyMessage={emptyMessage}
          isLoading={isLoading}
          isError={isError}
          loadingMessage={loadingMessage}
          errorMessage={errorMessage}
        />
      </PopoverContent>
    </Popover>
  );
}
