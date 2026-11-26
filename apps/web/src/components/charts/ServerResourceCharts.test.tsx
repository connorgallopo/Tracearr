import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type Highcharts from 'highcharts';
import type { ServerResourceDataPoint } from '@tracearr/shared';
import { ServerResourceCharts } from './ServerResourceCharts';

const { renderedOptions } = vi.hoisted(() => ({ renderedOptions: [] as Highcharts.Options[] }));

vi.mock('highcharts', () => ({ default: {} }));
vi.mock('highcharts-react-official', () => ({
  HighchartsReact: ({ options }: { options: Highcharts.Options }) => {
    renderedOptions.push(options);
    return null;
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./liveStatsAxis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./liveStatsAxis')>()),
  useSlidingWindow: () => undefined,
}));

const point = (at: number, over: Partial<ServerResourceDataPoint>): ServerResourceDataPoint => ({
  at,
  timespan: 5,
  hostCpuUtilization: 10,
  hostMemoryUtilization: 40,
  processCpuUtilization: null,
  processMemoryUtilization: 0,
  ...over,
});

const plex = {
  serverId: 'plex',
  serverName: 'Plex',
  color: 'orange',
  gapSeconds: 15,
  data: [
    point(100, { processCpuUtilization: 4, processMemoryUtilization: 3 }),
    point(105, { processCpuUtilization: 5, processMemoryUtilization: 3 }),
  ],
};

const silo = {
  serverId: 'silo',
  serverName: 'Silo',
  color: 'blue',
  gapSeconds: 15,
  data: [
    point(100, { processMemoryUtilization: 13 }),
    point(105, { processMemoryUtilization: 13 }),
  ],
};

const seriesNames = (options: Highcharts.Options | undefined) =>
  (options?.series ?? []).map((s) => s.name);

describe('ServerResourceCharts', () => {
  beforeEach(() => {
    renderedOptions.length = 0;
  });

  it('leaves a server that reports no CPU for its process off the CPU chart and keeps its memory', () => {
    render(<ServerResourceCharts data={undefined} multiSeries={[plex, silo]} />);

    const [cpu, memory] = renderedOptions.slice(-2);
    expect(seriesNames(cpu)).toEqual(['Plex']);
    expect(seriesNames(memory)).toEqual(['Plex', 'Silo']);
  });

  it('shows the empty state when no selected server reports the metric', () => {
    render(
      <ServerResourceCharts
        data={undefined}
        multiSeries={[silo, { ...silo, serverId: 'silo-2', serverName: 'Silo 2' }]}
      />
    );

    expect(screen.getAllByText('common:empty.noData')).toHaveLength(1);
    expect(seriesNames(renderedOptions[renderedOptions.length - 1])).toEqual(['Silo', 'Silo 2']);
  });

  it('draws only the system line on one server whose process reports no CPU', () => {
    render(<ServerResourceCharts data={silo.data} processLabel="Silo" />);

    const [cpu, memory] = renderedOptions.slice(-2);
    expect(seriesNames(cpu)).toEqual(['dashboard.resources.system']);
    expect(seriesNames(memory)).toEqual(['Silo', 'dashboard.resources.system']);
  });
});
