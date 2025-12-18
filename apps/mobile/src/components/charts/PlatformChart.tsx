/**
 * Donut chart showing plays by platform (matches web implementation)
 * Note: Touch interactions not yet supported on PolarChart (victory-native issue #252)
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Pie, PolarChart } from 'victory-native';
import { colors, spacing, borderRadius, typography } from '../../lib/theme';

interface PlatformChartProps {
  data: { platform: string; count: number }[];
  height?: number;
}

// Colors for pie slices - all visible against dark card background
const CHART_COLORS = [
  colors.cyan.core, // #18D1E7 - Cyan
  colors.info, // #3B82F6 - Bright Blue (not blue.core which matches bg!)
  colors.success, // #22C55E - Green
  colors.warning, // #F59E0B - Orange/Yellow
  colors.purple, // #8B5CF6 - Purple
  colors.error, // #EF4444 - Red
];

export function PlatformChart({ data }: PlatformChartProps) {
  // Sort by count and take top 5
  const sortedData = [...data]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((d, index) => ({
      label: d.platform.replace('Plex for ', '').replace('Jellyfin ', ''),
      value: d.count,
      color: CHART_COLORS[index % CHART_COLORS.length],
    }));

  if (sortedData.length === 0) {
    return (
      <View style={[styles.container, styles.emptyContainer]}>
        <Text style={styles.emptyText}>No platform data available</Text>
      </View>
    );
  }

  const total = sortedData.reduce((sum, item) => sum + item.value, 0);

  return (
    <View style={styles.container}>
      {/* Pie Chart */}
      <View style={styles.chartContainer}>
        <PolarChart data={sortedData} labelKey="label" valueKey="value" colorKey="color">
          <Pie.Chart innerRadius="50%" circleSweepDegrees={360} startAngle={0} />
        </PolarChart>
      </View>

      {/* Legend with percentages */}
      <View style={styles.legend}>
        {sortedData.map((item) => (
          <View key={item.label} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: item.color }]} />
            <Text style={styles.legendText} numberOfLines={1}>
              {item.label}
            </Text>
            <Text style={styles.legendPercent}>{Math.round((item.value / total) * 100)}%</Text>
          </View>
        ))}
      </View>
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
    minHeight: 150,
  },
  emptyText: {
    color: colors.text.muted.dark,
    fontSize: typography.fontSize.sm,
  },
  chartContainer: {
    height: 160,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.md,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border.dark,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontSize: typography.fontSize.xs,
    color: colors.text.muted.dark,
    maxWidth: 60,
  },
  legendPercent: {
    fontSize: typography.fontSize.xs,
    color: colors.text.secondary.dark,
    fontWeight: '500',
  },
});
