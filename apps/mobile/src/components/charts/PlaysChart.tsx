/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * Area chart showing plays over time with touch-to-reveal tooltip
 */
import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CartesianChart, Area, useChartPressState } from 'victory-native';
import { Circle } from '@shopify/react-native-skia';
import { useAnimatedReaction, runOnJS } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { colors, spacing, borderRadius, typography } from '../../lib/theme';
import { useChartFont } from './useChartFont';

interface PlaysChartProps {
  data: { date: string; count: number }[];
  height?: number;
}

function ToolTip({ x, y }: { x: SharedValue<number>; y: SharedValue<number> }) {
  return <Circle cx={x} cy={y} r={6} color={colors.cyan.core} />;
}

export function PlaysChart({ data, height = 200 }: PlaysChartProps) {
  const font = useChartFont(10);
  const { state, isActive } = useChartPressState({ x: 0, y: { count: 0 } });

  // React state to display values (synced from SharedValues)
  const [displayValue, setDisplayValue] = useState<{
    index: number;
    count: number;
  } | null>(null);

  // Transform data for victory-native
  const chartData = data.map((d, index) => ({
    x: index,
    count: d.count,
    label: d.date,
  }));

  // Sync SharedValue changes to React state
  const updateDisplayValue = useCallback((index: number, count: number) => {
    setDisplayValue({ index: Math.round(index), count: Math.round(count) });
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

  if (chartData.length === 0) {
    return (
      <View style={[styles.container, styles.emptyContainer, { height }]}>
        <Text style={styles.emptyText}>No play data available</Text>
      </View>
    );
  }

  // Get date label from React state
  const dateLabel =
    displayValue && chartData[displayValue.index]?.label
      ? new Date(chartData[displayValue.index].label).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        })
      : '';

  return (
    <View style={[styles.container, { height }]}>
      {/* Active value display */}
      <View style={styles.valueDisplay}>
        {displayValue ? (
          <>
            <Text style={styles.valueText}>{displayValue.count} plays</Text>
            <Text style={styles.dateText}>{dateLabel}</Text>
          </>
        ) : null}
      </View>

      <CartesianChart
        data={chartData}
        xKey="x"
        yKeys={['count']}
        domainPadding={{ top: 20, bottom: 10, left: 5, right: 5 }}
        chartPressState={state}
        axisOptions={{
          font,
          tickCount: { x: 5, y: 4 },
          lineColor: colors.border.dark,
          labelColor: colors.text.muted.dark,
          formatXLabel: (value) => {
            const item = chartData[Math.round(value)];
            if (!item) return '';
            const date = new Date(item.label);
            return `${date.getMonth() + 1}/${date.getDate()}`;
          },
          formatYLabel: (value) => String(Math.round(value)),
        }}
      >
        {({ points, chartBounds }) => (
          <>
            <Area
              points={points.count}
              y0={chartBounds.bottom}
              color={colors.cyan.core}
              opacity={0.6}
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
    minHeight: 20,
  },
  valueText: {
    color: colors.cyan.core,
    fontSize: typography.fontSize.sm,
    fontWeight: '600',
  },
  dateText: {
    color: colors.text.muted.dark,
    fontSize: typography.fontSize.xs,
  },
});
