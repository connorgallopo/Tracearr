import { useTranslation } from 'react-i18next';
import type { MediaRequestStatus } from '@tracearr/shared';
import type { VariantProps } from 'class-variance-authority';
import { Badge, type badgeVariants } from '@/components/ui/badge';

type BadgeVariant = VariantProps<typeof badgeVariants>['variant'];

const STATUS_VARIANTS: Record<MediaRequestStatus, BadgeVariant> = {
  pending: 'warning',
  approved: 'secondary',
  completed: 'success',
  declined: 'danger',
  failed: 'danger',
};

interface RequestStatusBadgeProps {
  status: MediaRequestStatus;
  deletedAt: string | null;
}

/** The single definition of request status labels and variants. */
export function RequestStatusBadge({ status, deletedAt }: RequestStatusBadgeProps) {
  const { t } = useTranslation('pages');

  if (deletedAt !== null) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {t('requests.status.deleted')}
      </Badge>
    );
  }

  return <Badge variant={STATUS_VARIANTS[status]}>{t(`requests.status.${status}`)}</Badge>;
}
