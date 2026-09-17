import type { ResolutionLabel } from '@tracearr/shared';

/** Higher tiers get cooler colors, so a chart reads best to worst at a glance. */
export const RESOLUTION_COLORS: Record<ResolutionLabel, string> = {
  '8K': '#8b5cf6',
  '4K': '#10b981',
  '1440p': '#06b6d4',
  '1080p': '#3b82f6',
  '720p': '#f59e0b',
  '480p': '#f97316',
  SD: '#ef4444',
};
