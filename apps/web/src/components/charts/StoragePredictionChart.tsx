import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts/highcharts-more';
import { HighchartsReact } from 'highcharts-react-official';
import type { LibraryStorageResponse } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate } from '@/lib/dateFormat';
import { TrendingUp } from 'lucide-react';
import { chartLang } from './chartUtils';

interface StoragePredictionChartProps {
  data: LibraryStorageResponse | undefined;
  isLoading?: boolean;
  height?: number;
  /** Time period for determining prediction range. 'all' hides predictions. */
  period?: 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';
  /** Whether to show predictions. When false, historical takes full chart. */
  showPredictions?: boolean;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * Determine the best unit for displaying a range of byte values.
 * Returns the unit index and divisor.
 */
function getBestUnit(maxBytes: number): { unitIndex: number; divisor: number } {
  if (maxBytes === 0) return { unitIndex: 3, divisor: 1024 ** 3 }; // Default to GB
  const k = 1024;
  const unitIndex = Math.min(Math.floor(Math.log(maxBytes) / Math.log(k)), BYTE_UNITS.length - 1);
  return { unitIndex, divisor: Math.pow(k, unitIndex) };
}

/**
 * Convert bytes string to a number in the specified unit.
 */
function bytesToUnit(bytes: string, divisor: number): number {
  return Number(BigInt(bytes)) / divisor;
}

export function StoragePredictionChart({
  data,
  isLoading,
  height = 300,
  period = 'month',
  showPredictions: showPredictionsProp = true,
}: StoragePredictionChartProps) {
  const { t } = useTranslation('pages');
  const options = useMemo<Highcharts.Options>(() => {
    if (!data?.history || data.history.length === 0) {
      return {};
    }

    // Determine prediction days based on period (matches historical range)
    // 'all' and 'custom' hide predictions, or when explicitly disabled via prop
    const showPredictions = showPredictionsProp && period !== 'all' && period !== 'custom';
    const predictionDays =
      period === 'day'
        ? 1
        : period === 'week'
          ? 7
          : period === 'month'
            ? 30
            : period === 'year'
              ? 365
              : 0;

    // Find max value to determine best unit for display
    const maxHistorical = Math.max(...data.history.map((d) => Number(BigInt(d.totalSizeBytes))));

    // Only consider predictions for max if we're showing them
    let maxPrediction = maxHistorical;
    if (showPredictions && data.predictions.day365) {
      maxPrediction = Number(BigInt(data.predictions.day365.max));
    } else if (showPredictions && data.predictions.day90) {
      maxPrediction = Number(BigInt(data.predictions.day90.max));
    } else if (showPredictions && data.predictions.day30) {
      maxPrediction = Number(BigInt(data.predictions.day30.max));
    }

    const maxValue = Math.max(maxHistorical, maxPrediction);
    const { unitIndex, divisor } = getBestUnit(maxValue);
    const unitLabel = BYTE_UNITS[unitIndex];

    // Convert historical data to chosen unit
    const historicalData = data.history.map((d) => ({
      x: new Date(d.day).getTime(),
      y: bytesToUnit(d.totalSizeBytes, divisor),
    }));

    const lastHistoricalPoint = historicalData[historicalData.length - 1];
    if (!lastHistoricalPoint) {
      return {};
    }
    const lastHistoricalDate = lastHistoricalPoint.x;

    // Build prediction data points (only if not 'all')
    const predictionPoints: { x: number; y: number; low: number; high: number }[] = [];
    const predictions = data.predictions;

    // Start prediction line from last historical point
    const predictionLineData: [number, number][] = [[lastHistoricalDate, lastHistoricalPoint.y]];

    // Only add predictions if we're showing them and they exist
    if (showPredictions && predictionDays > 0) {
      const bytesPerDay = Number(data.growthRate.bytesPerDay);
      const currentBytes = Number(BigInt(data.current.totalSizeBytes));
      const confidence = predictions.confidence;
      const marginPercent = confidence === 'high' ? 0.1 : confidence === 'medium' ? 0.25 : 0.5;
      const msPerDay = 24 * 60 * 60 * 1000;

      // Match prediction point granularity to X-axis tick intervals
      // year = monthly (~12 points), month = every 2 days (~15 points), week = daily (7 points)
      const intervalDays = period === 'year' ? 30 : period === 'month' ? 2 : 1;
      const numPoints = Math.ceil(predictionDays / intervalDays);

      for (let i = 1; i <= numPoints; i++) {
        const daysOut = Math.min(i * intervalDays, predictionDays);
        const predictedBytes = currentBytes + bytesPerDay * daysOut;
        // Margin grows with time (uncertainty increases)
        const margin = predictedBytes * marginPercent * (daysOut / predictionDays);

        const timestamp = lastHistoricalDate + daysOut * msPerDay;
        const predicted = predictedBytes / divisor;
        const min = Math.max(0, predictedBytes - margin) / divisor;
        const max = (predictedBytes + margin) / divisor;

        predictionPoints.push({ x: timestamp, y: predicted, low: min, high: max });
        predictionLineData.push([timestamp, predicted]);
      }
    }

    // Build arearange data for confidence bands
    const confidenceBandData: [number, number, number][] = predictionPoints.map((p) => [
      p.x,
      p.low,
      p.high,
    ]);

    // Series array
    const series: Highcharts.SeriesOptionsType[] = [
      {
        type: 'area',
        name: t('library.charts.storage.historical'),
        data: historicalData,
        fillColor: {
          linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
          stops: [
            [0, 'oklch(var(--primary) / 0.3)'],
            [1, 'oklch(var(--primary) / 0.05)'],
          ],
        },
        lineColor: 'oklch(var(--primary))',
        lineWidth: 2,
        marker: {
          enabled: false,
          states: {
            hover: {
              enabled: true,
              radius: 4,
            },
          },
        },
      },
    ];

    // Add prediction series only if we have predictions
    if (predictionPoints.length > 0) {
      series.push({
        type: 'line',
        name: t('library.charts.storage.prediction'),
        data: predictionLineData,
        color: 'oklch(var(--chart-2))',
        dashStyle: 'ShortDash',
        lineWidth: 2,
        marker: {
          enabled: true,
          radius: 4,
        },
      });

      series.push({
        type: 'arearange',
        name: t('library.storage.confidence'),
        data: confidenceBandData,
        color: 'oklch(var(--chart-2))',
        fillOpacity: 0.15,
        lineWidth: 0,
        linkedTo: ':previous',
        marker: {
          enabled: false,
        },
      });
    }

    return {
      lang: chartLang(),
      chart: {
        type: 'area',
        height,
        backgroundColor: 'transparent',
        style: {
          fontFamily: 'inherit',
        },
        reflow: true,
      },
      title: {
        text: undefined,
      },
      credits: {
        enabled: false,
      },
      legend: {
        enabled: predictionPoints.length > 0,
        align: 'right',
        verticalAlign: 'top',
        floating: false,
        itemStyle: {
          color: 'oklch(var(--muted-foreground))',
          fontWeight: 'normal',
          fontSize: '12px',
        },
        itemHoverStyle: {
          color: 'oklch(var(--foreground))',
        },
      },
      xAxis: {
        type: 'datetime',
        labels: {
          style: {
            color: 'oklch(var(--muted-foreground))',
          },
          formatter: function () {
            // Include year for longer time periods (year/all) to differentiate labels
            return formatDate(
              new Date(this.value),
              period === 'year' || period === 'all'
                ? { month: 'short', year: '2-digit' }
                : { month: 'short', day: 'numeric' }
            );
          },
        },
        lineColor: 'oklch(var(--border))',
        tickColor: 'oklch(var(--border))',
        plotLines:
          predictionPoints.length > 0
            ? [
                {
                  color: 'oklch(var(--border))',
                  width: 1,
                  value: lastHistoricalDate,
                  dashStyle: 'Dash',
                  label: {
                    text: t('library.charts.storage.now'),
                    style: {
                      color: 'oklch(var(--muted-foreground))',
                      fontSize: '12px',
                    },
                    verticalAlign: 'top',
                    y: 12,
                  },
                },
              ]
            : [],
      },
      yAxis: {
        title: {
          text: t('library.charts.storage.axis', { unit: unitLabel }),
          style: {
            color: 'oklch(var(--muted-foreground))',
          },
        },
        labels: {
          style: {
            color: 'oklch(var(--muted-foreground))',
          },
          formatter: function () {
            return `${this.value?.toLocaleString()} ${unitLabel}`;
          },
        },
        gridLineColor: 'oklch(var(--border))',
        min: 0,
      },
      tooltip: {
        backgroundColor: 'oklch(var(--popover))',
        borderColor: 'oklch(var(--border))',
        style: {
          color: 'oklch(var(--popover-foreground))',
        },
        shared: true,
        formatter: function () {
          const dateStr = formatDate(this.x, { month: 'short', day: 'numeric', year: 'numeric' });

          let html = `<b>${dateStr}</b>`;
          const points = this.points || [];

          for (const point of points) {
            if (point.series.type === 'arearange') {
              // Show range for confidence band - access low/high from the point
              const rangePoint = point as unknown as { low: number; high: number; color: string };
              const range = t('library.charts.storage.range', {
                low: rangePoint.low?.toFixed(1),
                high: rangePoint.high?.toFixed(1),
                unit: unitLabel,
              });
              html += `<br/><span style="color:${point.color}">●</span> ${range}`;
            } else {
              html += `<br/><span style="color:${point.color}">●</span> ${point.series.name}: ${point.y?.toFixed(1)} ${unitLabel}`;
            }
          }
          return html;
        },
      },
      plotOptions: {
        area: {
          threshold: null,
        },
      },
      series,
      responsive: {
        rules: [
          {
            condition: {
              maxWidth: 400,
            },
            chartOptions: {
              legend: {
                floating: false,
                align: 'center',
                verticalAlign: 'bottom',
              },
              yAxis: {
                title: {
                  text: undefined,
                },
              },
            },
          },
        ],
      },
    };
  }, [data, height, period, showPredictionsProp, t]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data?.history || data.history.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title={t('library.charts.storage.empty.title')}
        description={t('library.charts.storage.empty.description')}
      />
    );
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}
