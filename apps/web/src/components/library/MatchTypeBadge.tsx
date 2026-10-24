import { useTranslation } from 'react-i18next';
import type { MatchType } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';

interface MatchTypeBadgeProps {
  matchType: MatchType;
  confidence: number;
}

const MATCH_LABEL_KEYS = {
  imdb: null,
  tmdb: null,
  tvdb: null,
  mbid: null,
  fuzzy: 'library.storage.matchBadge.fuzzy',
  version: 'library.storage.matchBadge.versions',
} as const satisfies Record<MatchType, string | null>;

/**
 * Get confidence level label key and badge variant based on confidence score.
 * - high (>= 90): "Exact" with success variant (green)
 * - medium (>= 70): "Likely" with warning variant (yellow)
 * - low (< 70): "Possible" with secondary variant (neutral)
 */
function getConfidenceInfo(confidence: number) {
  if (confidence >= 90) {
    return { labelKey: 'library.storage.matchBadge.exact', variant: 'success' } as const;
  }
  if (confidence >= 70) {
    return { labelKey: 'library.storage.matchBadge.likely', variant: 'warning' } as const;
  }
  return { labelKey: 'library.storage.matchBadge.possible', variant: 'secondary' } as const;
}

/**
 * Badge component for displaying duplicate match type and confidence level.
 * Format: "{confidenceLabel} ({matchLabel})" e.g. "Exact (IMDB)", "Possible (Fuzzy)"
 */
export function MatchTypeBadge({ matchType, confidence }: MatchTypeBadgeProps) {
  const { t } = useTranslation('pages');
  const matchKey = MATCH_LABEL_KEYS[matchType];
  const matchLabel = matchKey ? t(matchKey) : matchType.toUpperCase();
  const { labelKey, variant } = getConfidenceInfo(confidence);

  return (
    <Badge variant={variant}>
      {t('library.storage.matchBadge.label', { confidence: t(labelKey), match: matchLabel })}
    </Badge>
  );
}
