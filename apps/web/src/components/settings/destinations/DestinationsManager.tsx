import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Destination } from '@tracearr/shared';
import { Bell, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useDestinations } from '@/hooks/queries/useDestinations';
import { DestinationCard } from './DestinationCard';
import { DestinationDialog } from './DestinationDialog';

type DialogState = { mode: 'create' } | { mode: 'edit'; destination: Destination };

export function DestinationsManager() {
  const { t } = useTranslation('pages');
  const { data: destinations, isLoading } = useDestinations();
  const [dialog, setDialog] = useState<DialogState | null>(null);

  if (isLoading) {
    return (
      <div className="@container/destinations">
        <div className="grid gap-4 @2xl/destinations:grid-cols-2 @4xl/destinations:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const rows = [...(destinations ?? [])].sort((a, b) => Number(b.builtin) - Number(a.builtin));

  const addButton = (
    <Button onClick={() => setDialog({ mode: 'create' })}>
      <Plus className="h-4 w-4" />
      {t('settings.destinations.add')}
    </Button>
  );

  return (
    <div className="@container/destinations space-y-4">
      {rows.length === 0 ? (
        <EmptyState icon={Bell} title={t('settings.destinations.empty')}>
          {addButton}
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-4 @2xl/destinations:grid-cols-2 @4xl/destinations:grid-cols-3">
            {rows.map((destination) => (
              <DestinationCard
                key={destination.id}
                destination={destination}
                onEdit={() => setDialog({ mode: 'edit', destination })}
              />
            ))}
          </div>
          {addButton}
        </>
      )}

      {dialog && (
        <DestinationDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          mode={dialog.mode}
          destination={dialog.mode === 'edit' ? dialog.destination : undefined}
        />
      )}
    </div>
  );
}
