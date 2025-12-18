/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * Bar chart showing plays by day of week with touch interaction
 */
import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CartesianChart, Bar, useChartPressState } from 'victory-native';
import { Circle } from '@shopify/react-native-skia';
import { useAnimatedReaction, runOnJS } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { colors, spacing, borderRadius, typography } from '../../lib/theme';
import { useChartFont } from './useChartFont';

interface DayOfWeekChartProps {
  data: { day: number; name: string; count: number }[];
  height?: number;
}

const DAY_ABBREV = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ToolTip({ x, y }: { x: SharedValue<number>; y: SharedValue<number> }) {
  return <Circle cx={x} cy={y} r={5} color={colors.cyan.core} />;
}

export function DayOfWeekChart({ data, height = 180 }: DayOfWeekChartProps) {
  const font = useChartFont(10);
  const { state, isActive } = useChartPressState({ x: 0, y: { count: 0 } });

  // React state to display values (synced from SharedValues)
  const [displayValue, setDisplayValue] = useState<{
    day: number;
    count: number;
  } | null>(null);

  // Sync SharedValue changes to React state
  const updateDisplayValue = useCallback((day: number, count: number) => {
    setDisplayValue({ day: Math.round(day), count: Math.round(count) });
  }, []);

  const clearDisplayValue = useCallback(() => {
    setDisplayValue(null);
  }, []);

  // Watch for changes in chart press state
  useAnimatedReaction(
    () => ({
      active: isActive,
      x: state.x.value.value,
      y: state.y.count.value.value,
    }),
    (current, previous) => {
      if (current.active) {
        runOnJS(updateDisplayValue)(current.x, current.y);
      } else if (previous?.active && !current.active) {
        runOnJS(clearDisplayValue)();
      }
    },
    [isActive]
  );

  // Transform data for victory-native
  const chartData = data.map((d) => ({
    x: d.day,
    count: d.count,
    name: d.name,
  }));

  if (chartData.length === 0) {
    return (
      <View style={[styles.container, styles.emptyContainer, { height }]}>
        <Text style={styles.emptyText}>No data available</Text>
      </View>
    );
  }

  // Find the selected day name from React state
  const selectedDay = displayValue ? chartData.find((d) => d.x === displayValue.day) : null;

  return (
    <View style={[styles.container, { height }]}>
      {/* Active value display */}
      <View style={styles.valueDisplay}>
        {displayValue && selectedDay ? (
          <>
            <Text style={styles.valueText}>{displayValue.count} plays</Text>
            <Text style={styles.dayText}>{selectedDay.name}</Text>
          </>
        ) : null}
      </View>

      <CartesianChart
        data={chartData}
        xKey="x"
        yKeys={['count']}
        domainPadding={{ left: 25, right: 25, top: 20 }}
        chartPressState={state}
        axisOptions={{
          font,
          tickCount: { x: 7, y: 4 },
          lineColor: colors.border.dark,
          labelColor: colors.text.muted.dark,
          formatXLabel: (value) => DAY_ABBREV[Math.round(value)] || '',
          formatYLabel: (value) => String(Math.round(value)),
        }}
      >
        {({ points, chartBounds }) => (
          <>
            <Bar
              points={points.count}
              chartBounds={chartBounds}
              color={colors.cyan.core}
              roundedCorners={{ topLeft: 4, topRight: 4 }}
              animate={{ type: 'timing', duration: 500 }}
            />
            {isActive && <ToolTip x={state.x.position} y={state.y.count.position} />}
          </>
        )}
      </CartesianChart>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.card.dark,
    borderRadius: borderRadius.lg,
    padding: spacing.sm,
  },
  emptyContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: colors.text.muted.dark,
    fontSize: typography.fontSize.sm,
  },
  valueDisplay: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.xs,
    minHeight: 18,
  },
  valueText: {
    color: colors.cyan.core,
    fontSize: typography.fontSize.sm,
    fontWeight: '600',
  },
  dayText: {
    color: colors.text.muted.dark,
    fontSize: typography.fontSize.xs,
  },
});
