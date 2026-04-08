/**
 * History filters component - compact filter bar with bottom sheet trigger
 * Mobile-optimized design with time range picker, search, and filter button
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable, TextInput } from 'react-native';
import { Search, X, SlidersHorizontal } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { colors } from '@/lib/theme';
import { useTranslation } from '@tracearr/translations/mobile';

export type TimePeriod = '7d' | '30d' | '90d' | '1y' | 'all';
export type MediaType = 'movie' | 'episode' | 'track' | 'live';
export type TranscodeDecision = 'directplay' | 'copy' | 'transcode';

interface HistoryFiltersProps {
  period: TimePeriod;
  onPeriodChange: (period: TimePeriod) => void;
  search: string;
  onSearchChange: (search: string) => void;
  activeFilterCount: number;
  onFilterPress: () => void;
}

const PERIODS: { value: TimePeriod; label: string }[] = [
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: '1y', label: '1y' },
  { value: 'all', label: 'All' },
];

function TimeRangePicker({
  value,
  onChange,
}: {
  value: TimePeriod;
  onChange: (value: TimePeriod) => void;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: colors.surface.dark,
        borderRadius: 8,
        padding: 4,
      }}
    >
      {PERIODS.map((period) => {
        const isSelected = value === period.value;
        return (
          <Pressable
            key={period.value}
            onPress={() => onChange(period.value)}
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: 8,
              paddingHorizontal: 12,
              borderRadius: 6,
              backgroundColor: isSelected ? colors.card.dark : 'transparent',
            }}
          >
            <Text
              style={{
                fontSize: 13,
                fontWeight: '600',
                color: isSelected ? colors.text.primary.dark : colors.text.muted.dark,
              }}
            >
              {period.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function HistoryFilters({
  period,
  onPeriodChange,
  search,
  onSearchChange,
  activeFilterCount,
  onFilterPress,
}: HistoryFiltersProps) {
  const { t } = useTranslation(['common']);
  const [localSearch, setLocalSearch] = useState(search);

  // Sync with external search value
  useEffect(() => {
    setLocalSearch(search);
  }, [search]);

  // Debounced search
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (localSearch !== search) {
        onSearchChange(localSearch);
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [localSearch, search, onSearchChange]);

  const handleClearSearch = useCallback(() => {
    setLocalSearch('');
    onSearchChange('');
  }, [onSearchChange]);

  return (
    <View className="mb-4 gap-2">
      {/* Time Range Picker */}
      <TimeRangePicker value={period} onChange={onPeriodChange} />

      {/* Search and Filter Row */}
      <View className="flex-row gap-2">
        {/* Search Bar */}
        <View className="bg-card h-10 flex-1 flex-row items-center rounded-lg px-2">
          <Search size={16} color={colors.text.muted.dark} className="mr-1" />
          <TextInput
            className="text-foreground flex-1 py-0 text-sm"
            placeholder={t('common:search.searchTitles')}
            placeholderTextColor={colors.text.muted.dark}
            value={localSearch}
            onChangeText={setLocalSearch}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {localSearch.length > 0 && (
            <Pressable onPress={handleClearSearch} className="p-1">
              <X size={14} color={colors.text.muted.dark} />
            </Pressable>
          )}
        </View>

        {/* Filter Button */}
        <Pressable
          onPress={onFilterPress}
          className="bg-card h-10 w-11 items-center justify-center rounded-lg"
        >
          <SlidersHorizontal size={18} color={colors.text.primary.dark} />
          {activeFilterCount > 0 && (
            <View className="bg-primary absolute top-1 right-1 min-w-4 items-center justify-center rounded-full px-1">
              <Text className="text-primary-foreground text-[10px] font-bold">
                {activeFilterCount}
              </Text>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
}
