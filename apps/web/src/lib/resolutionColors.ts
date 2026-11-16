import type { ResolutionLabel } from '@tracearr/shared';

/** Tiers are ordered, so they sit on the sequential ramp: the highest tier is the strongest step. */
export const RESOLUTION_COLORS: Record<ResolutionLabel, string> = {
  '8K': 'oklch(var(--seq-1))',
  '4K': 'oklch(var(--seq-2))',
  '1440p': 'oklch(var(--seq-3))',
  '1080p': 'oklch(var(--seq-4))',
  '720p': 'oklch(var(--seq-5))',
  '480p': 'oklch(var(--seq-6))',
  SD: 'oklch(var(--seq-7))',
};
