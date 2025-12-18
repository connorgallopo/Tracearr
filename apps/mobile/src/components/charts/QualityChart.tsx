/**
 * Simple chart showing direct play vs transcode breakdown
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing, borderRadius, typography } from '../../lib/theme';

interface QualityChartProps {
  directPlay: number;
  transcode: number;
  directPlayPercent: number;
  transcodePercent: number;
  height?: number;
}

export function QualityChart({
  directPlay,
  transcode,
  directPlayPercent,
  transcodePercent,
  height = 120,
}: QualityChartProps) {
  const total = directPlay + transcode;

  if (total === 0) {
    return (
      <View style={[styles.container, styles.emptyContainer, { height }]}>
        <Text style={styles.emptyText}>No playback data available</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { height }]}>
      {/* Progress bar */}
      <View style={styles.barContainer}>
        <View style={[styles.directBar, { flex: directPlayPercent || 1 }]} />
        <View style={[styles.transcodeBar, { flex: transcodePercent || 1 }]} />
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: colors.success }]} />
          <Text style={styles.legendLabel}>Direct Play</Text>
          <Text style={styles.legendValue}>
            {directPlay} ({directPlayPercent}%)
          </Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: colors.warning }]} />
          <Text style={styles.legendLabel}>Transcode</Text>
          <Text style={styles.legendValue}>
            {transcode} ({transcodePercent}%)
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.card.dark,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    justifyContent: 'center',
  },
  emptyContainer: {
    alignItems: 'center',
  },
  emptyText: {
    color: colors.text.muted.dark,
    fontSize: typography.fontSize.sm,
  },
  barContainer: {
    flexDirection: 'row',
    height: 24,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  directBar: {
    backgroundColor: colors.success,
  },
  transcodeBar: {
    backgroundColor: colors.warning,
  },
  legend: {
    gap: spacing.sm,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendLabel: {
    flex: 1,
    color: colors.text.primary.dark,
    fontSize: typography.fontSize.sm,
  },
  legendValue: {
    color: colors.text.muted.dark,
    fontSize: typography.fontSize.sm,
  },
});
