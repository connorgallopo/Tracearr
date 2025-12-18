/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * Bar chart showing plays by hour of day with touch interaction
 */
import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CartesianChart, Bar, useChartPressState } from 'victory-native';
import { Circle } from '@shopify/react-native-skia';
import { useAnimatedReaction, runOnJS } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { colors, spacing, borderRadius, typography } from '../../lib/theme';
import { useChartFont } from './useChartFont';

interface HourOfDayChartProps {
  data: { hour: number; count: number }[];
  height?: number;
}

function ToolTip({ x, y }: { x: SharedValue<number>; y: SharedValue<number> }) {
  return <Circle cx={x} cy={y} r={5} color={colors.purple} />;
}

function formatHour(hour: number): string {
  if (hour === 0) return '12am';
  if (hour === 12) return '12pm';
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

export function HourOfDayChart({ data, height = 180 }: HourOfDayChartProps) {
  const font = useChartFont(9);
  const { state, isActive } = useChartPressState({ x: 0, y: { count: 0 } });

  // React state to display values (synced from SharedValues)
  const [displayValue, setDisplayValue] = useState<{
    hour: number;
    count: number;
  } | null>(null);

  // Sync SharedValue changes to React state
  const updateDisplayValue = useCallback((hour: number, count: number) => {
    setDisplayValue({ hour: Math.round(hour), count: Math.round(count) });
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
    x: d.hour,
    count: d.count,
  }));

  if (chartData.length === 0) {
    return (
      <View style={[styles.container, styles.emptyContainer, { height }]}>
        <Text style={styles.emptyText}>No data available</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { height }]}>
      {/* Active value display */}
      <View style={styles.valueDisplay}>
        {displayValue ? (
          <>
            <Text style={styles.valueText}>{displayValue.count} plays</Text>
            <Text style={styles.hourText}>{formatHour(displayValue.hour)}</Text>
          </>
        ) : null}
      </View>

      <CartesianChart
        data={chartData}
        xKey="x"
        yKeys={['count']}
        domainPadding={{ left: 10, right: 10, top: 20 }}
        chartPressState={state}
        axisOptions={{
          font,
          tickCount: { x: 6, y: 4 },
          lineColor: colors.border.dark,
          labelColor: colors.text.muted.dark,
          formatXLabel: (value) => {
            const hour = Math.round(value);
            // Only show labels for 0, 6, 12, 18 to avoid crowding
            if (hour % 6 === 0) {
              return formatHour(hour);
            }
            return '';
          },
          formatYLabel: (value) => String(Math.round(value)),
        }}
      >
        {({ points, chartBounds }) => (
          <>
            <Bar
              points={points.count}
              chartBounds={chartBounds}
              color={colors.purple}
              roundedCorners={{ topLeft: 2, topRight: 2 }}
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
    color: colors.purple,
    fontSize: typography.fontSize.sm,
    fontWeight: '600',
  },
  hourText: {
    color: colors.text.muted.dark,
    fontSize: typography.fontSize.xs,
  },
});
