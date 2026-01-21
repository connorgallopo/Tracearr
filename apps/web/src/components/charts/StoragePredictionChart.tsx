import { useMemo } from 'react';
import Highcharts from 'highcharts/highcharts-more';
import HighchartsReact from 'highcharts-react-official';
import type { LibraryStorageResponse } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/library';
import { TrendingUp } from 'lucide-react';

interface StoragePredictionChartProps {
  data: LibraryStorageResponse | undefined;
  isLoading?: boolean;
  height?: number;
}

// Convert bytes string to GB using BigInt for precision
function bytesToGb(bytes: string): number {
  return Number(BigInt(bytes) / BigInt(1024 ** 3));
}

export function StoragePredictionChart({
  data,
  isLoading,
  height = 300,
}: StoragePredictionChartProps) {
  const options = useMemo<Highcharts.Options>(() => {
    if (!data?.history || data.history.length === 0) {
      return {};
    }

    // Convert historical data
    const historicalData = data.history.map((d) => ({
      x: new Date(d.day).getTime(),
      y: bytesToGb(d.totalSizeBytes),
    }));

    const lastHistoricalPoint = historicalData[historicalData.length - 1];
    if (!lastHistoricalPoint) {
      return {};
    }
    const lastHistoricalDate = lastHistoricalPoint.x;

    // Build prediction data points
    const predictionPoints: { x: number; y: number; low: number; high: number }[] = [];
    const predictions = data.predictions;

    // Start prediction line from last historical point
    const predictionLineData: [number, number][] = [[lastHistoricalDate, lastHistoricalPoint.y]];

    // Only add predictions if they exist
    const dayOffsets = [
      { days: 30, prediction: predictions.day30 },
      { days: 90, prediction: predictions.day90 },
      { days: 365, prediction: predictions.day365 },
    ];

    for (const { days, prediction } of dayOffsets) {
      if (prediction) {
        const timestamp = lastHistoricalDate + days * 24 * 60 * 60 * 1000;
        const predicted = bytesToGb(prediction.predicted);
        const min = bytesToGb(prediction.min);
        const max = bytesToGb(prediction.max);

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
        name: 'Historical',
        data: historicalData,
        fillColor: {
          linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
          stops: [
            [0, 'hsl(var(--primary) / 0.3)'],
            [1, 'hsl(var(--primary) / 0.05)'],
          ],
        },
        lineColor: 'hsl(var(--primary))',
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
        name: 'Prediction',
        data: predictionLineData,
        color: 'hsl(var(--chart-2))',
        dashStyle: 'ShortDash',
        lineWidth: 2,
        marker: {
          enabled: true,
          radius: 4,
        },
      });

      series.push({
        type: 'arearange',
        name: 'Confidence',
        data: confidenceBandData,
        color: 'hsl(var(--chart-2))',
        fillOpacity: 0.15,
        lineWidth: 0,
        linkedTo: ':previous',
        marker: {
          enabled: false,
        },
      });
    }

    return {
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
        floating: true,
        itemStyle: {
          color: 'hsl(var(--muted-foreground))',
          fontWeight: 'normal',
          fontSize: '11px',
        },
        itemHoverStyle: {
          color: 'hsl(var(--foreground))',
        },
      },
      xAxis: {
        type: 'datetime',
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
          },
          formatter: function () {
            const date = new Date(this.value as number);
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          },
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
        plotLines:
          predictionPoints.length > 0
            ? [
                {
                  color: 'hsl(var(--border))',
                  width: 1,
                  value: lastHistoricalDate,
                  dashStyle: 'Dash',
                  label: {
                    text: 'Now',
                    style: {
                      color: 'hsl(var(--muted-foreground))',
                      fontSize: '10px',
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
          text: 'Storage (GB)',
          style: {
            color: 'hsl(var(--muted-foreground))',
          },
        },
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
          },
          formatter: function () {
            return `${this.value?.toLocaleString()} GB`;
          },
        },
        gridLineColor: 'hsl(var(--border))',
        min: 0,
      },
      tooltip: {
        backgroundColor: 'hsl(var(--popover))',
        borderColor: 'hsl(var(--border))',
        style: {
          color: 'hsl(var(--popover-foreground))',
        },
        shared: true,
        formatter: function () {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
          const date = new Date(this.x as number);
          const dateStr = date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });

          let html = `<b>${dateStr}</b>`;
          const points = this.points || [];

          for (const point of points) {
            if (point.series.type === 'arearange') {
              // Show range for confidence band - access low/high from the point
              const rangePoint = point as unknown as { low: number; high: number; color: string };
              html += `<br/><span style="color:${point.color}">●</span> Range: ${rangePoint.low?.toFixed(1)} - ${rangePoint.high?.toFixed(1)} GB`;
            } else {
              html += `<br/><span style="color:${point.color}">●</span> ${point.series.name}: ${point.y?.toFixed(1)} GB`;
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
                itemStyle: {
                  fontSize: '10px',
                },
              },
              xAxis: {
                labels: {
                  style: {
                    fontSize: '9px',
                  },
                },
              },
              yAxis: {
                title: {
                  text: undefined,
                },
                labels: {
                  style: {
                    fontSize: '9px',
                  },
                },
              },
            },
          },
        ],
      },
    };
  }, [data, height]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data?.history || data.history.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No storage data"
        description="Storage history will appear here once available"
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
