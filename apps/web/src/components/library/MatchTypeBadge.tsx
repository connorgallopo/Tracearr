import type { MatchType } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';

interface MatchTypeBadgeProps {
  matchType: MatchType;
  confidence: number;
}

const MATCH_LABELS: Record<MatchType, string> = {
  imdb: 'IMDB',
  tmdb: 'TMDB',
  tvdb: 'TVDB',
  fuzzy: 'Fuzzy',
};

/**
 * Get confidence level label and badge variant based on confidence score.
 * - high (>= 0.9): "Exact" with success variant (green)
 * - medium (>= 0.7): "Likely" with warning variant (yellow)
 * - low (< 0.7): "Possible" with secondary variant (neutral)
 */
function getConfidenceInfo(confidence: number): {
  label: string;
  variant: 'success' | 'warning' | 'secondary';
} {
  if (confidence >= 0.9) {
    return { label: 'Exact', variant: 'success' };
  }
  if (confidence >= 0.7) {
    return { label: 'Likely', variant: 'warning' };
  }
  return { label: 'Possible', variant: 'secondary' };
}

/**
 * Badge component for displaying duplicate match type and confidence level.
 * Format: "{confidenceLabel} ({matchLabel})" e.g. "Exact (IMDB)", "Possible (Fuzzy)"
 */
export function MatchTypeBadge({ matchType, confidence }: MatchTypeBadgeProps) {
  const matchLabel = MATCH_LABELS[matchType];
  const { label: confidenceLabel, variant } = getConfidenceInfo(confidence);

  return (
    <Badge variant={variant}>
      {confidenceLabel} ({matchLabel})
    </Badge>
  );
}
