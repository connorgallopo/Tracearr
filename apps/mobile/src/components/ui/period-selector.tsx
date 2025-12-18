/**
 * Segmented control for selecting time periods (7d, 30d, 1y)
 */
import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Text } from './text';
import { colors, spacing, borderRadius } from '@/lib/theme';

export type StatsPeriod = 'week' | 'month' | 'year';

interface PeriodSelectorProps {
  value: StatsPeriod;
  onChange: (value: StatsPeriod) => void;
}

const PERIODS: { value: StatsPeriod; label: string }[] = [
  { value: 'week', label: '7d' },
  { value: 'month', label: '30d' },
  { value: 'year', label: '1y' },
];

export function PeriodSelector({ value, onChange }: PeriodSelectorProps) {
  return (
    <View style={styles.container}>
      {PERIODS.map((period) => {
        const isSelected = value === period.value;
        return (
          <Pressable
            key={period.value}
            onPress={() => onChange(period.value)}
            style={[styles.button, isSelected && styles.buttonSelected]}
          >
            <Text style={[styles.buttonText, isSelected && styles.buttonTextSelected]}>
              {period.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: colors.surface.dark,
    borderRadius: borderRadius.lg,
    padding: 4,
  },
  button: {
    paddingHorizontal: spacing.md,
    paddingVertical: (spacing.xs as number) + 2,
    borderRadius: borderRadius.md,
  },
  buttonSelected: {
    backgroundColor: colors.card.dark,
  },
  buttonText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.text.muted.dark,
  },
  buttonTextSelected: {
    color: colors.text.primary.dark,
  },
});
