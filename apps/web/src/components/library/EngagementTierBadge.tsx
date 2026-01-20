import type { CompletionStatus } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';

interface EngagementTierBadgeProps {
  status: CompletionStatus;
}

const STATUS_VARIANTS: Record<CompletionStatus, 'success' | 'warning' | 'secondary'> = {
  completed: 'success', // Green
  in_progress: 'warning', // Yellow/Orange
  not_started: 'secondary', // Neutral
};

const STATUS_LABELS: Record<CompletionStatus, string> = {
  completed: 'Completed',
  in_progress: 'In Progress',
  not_started: 'Not Started',
};

/**
 * Badge component for displaying completion status with color coding.
 * Green for completed, yellow for in progress, neutral for not started.
 */
export function EngagementTierBadge({ status }: EngagementTierBadgeProps) {
  return <Badge variant={STATUS_VARIANTS[status]}>{STATUS_LABELS[status]}</Badge>;
}
