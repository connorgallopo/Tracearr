import type { ValueCategory } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';

interface ValueCategoryBadgeProps {
  category: ValueCategory;
  suggestDeletion?: boolean;
}

const VALUE_VARIANTS: Record<ValueCategory, 'danger' | 'warning' | 'success'> = {
  low_value: 'danger', // Red - deletion candidates
  moderate_value: 'warning', // Yellow - watchlist
  high_value: 'success', // Green - valuable content
};

const VALUE_LABELS: Record<ValueCategory, string> = {
  low_value: 'Low Value',
  moderate_value: 'Moderate',
  high_value: 'High Value',
};

/**
 * Badge component for ROI value category display with optional deletion suggestion.
 * Color-coded: red (low), yellow (moderate), green (high value).
 */
export function ValueCategoryBadge({ category, suggestDeletion }: ValueCategoryBadgeProps) {
  const variant = VALUE_VARIANTS[category];
  const label = VALUE_LABELS[category];

  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant={variant}>{label}</Badge>
      {suggestDeletion && (
        <span className="text-muted-foreground text-xs">(deletion suggested)</span>
      )}
    </span>
  );
}
