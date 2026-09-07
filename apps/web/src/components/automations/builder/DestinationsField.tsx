/* eslint-disable @eslint-react/static-components --
 * The icon lookup returns a module-level component, so its reference is stable
 * across renders and nothing remounts. The rule cannot see that through the call.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addressList, type Destination } from '@tracearr/shared';
import { Check, Plus, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DestinationDialog } from '@/components/settings/destinations/DestinationDialog';
import { iconFor } from '@/components/settings/destinations/destinationIcons';
import { useDestinations } from '@/hooks/queries/useDestinations';
import { cn } from '@/lib/utils';
import { SELECTED_TOGGLE } from './selection';

interface DestinationsFieldProps {
  value: string[];
  onChange: (ids: string[]) => void;
  label: string;
  /** Set when an enclosing Field supplies the label, so this renders none of its own. */
  labelledBy?: string;
}

function byBuiltinThenName(a: Destination, b: Destination): number {
  if (a.builtin !== b.builtin) return Number(b.builtin) - Number(a.builtin);
  return a.name.localeCompare(b.name);
}

function lacksAlertRecipients(row: Destination): boolean {
  return (
    row.type === 'email' && row.config !== null && addressList(row.config.to ?? '').length === 0
  );
}

export function DestinationsField({ value, onChange, label, labelledBy }: DestinationsFieldProps) {
  const { t } = useTranslation(['pages', 'common']);
  const { data: destinations, isLoading } = useDestinations();
  const [addOpen, setAddOpen] = useState(false);
  const ownLabelId = useId();
  const labelId = labelledBy ?? ownLabelId;

  if (isLoading) {
    return <Skeleton className="h-8 w-64" />;
  }

  const rows = [...(destinations ?? [])].sort(byBuiltinThenName);
  // A rule can outlive the destination it sends to; keep those ids visible so they can be dropped.
  const missingIds = value.filter((id) => !rows.some((row) => row.id === id));

  const addButton = (
    <Button type="button" variant="outline" size="sm" onClick={() => setAddOpen(true)}>
      <Plus className="h-4 w-4" />
      {t('pages:automations.builder.newDestination')}
    </Button>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!labelledBy && (
        <span id={labelId} className="text-muted-foreground text-sm">
          {label}:
        </span>
      )}

      {rows.length === 0 && (
        <span className="text-muted-foreground text-sm">
          {t('pages:automations.builder.noDestinations')}
        </span>
      )}

      {rows.length > 0 && (
        <TooltipProvider delayDuration={100}>
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            spacing={2}
            value={value}
            onValueChange={onChange}
            aria-labelledby={labelId}
            className="flex-wrap"
          >
            {rows.map((row) => {
              const Icon = iconFor(row.type);
              const picked = value.includes(row.id);
              const quiet = lacksAlertRecipients(row);
              // A dimmed row stays pickable so an existing rule can keep it; the tooltip says why it is dimmed.
              const item = (
                <ToggleGroupItem
                  key={row.id}
                  value={row.id}
                  className={cn(
                    'rounded-full',
                    SELECTED_TOGGLE,
                    (!row.enabled || quiet) && 'opacity-60'
                  )}
                >
                  {picked ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                  {row.name}
                </ToggleGroupItem>
              );

              if (row.enabled && !quiet) return item;

              return (
                <Tooltip key={row.id}>
                  <TooltipTrigger asChild>{item}</TooltipTrigger>
                  <TooltipContent>
                    {row.enabled
                      ? t('pages:automations.builder.noAlertRecipientsTooltip')
                      : t('pages:automations.builder.destinationDisabled')}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </ToggleGroup>
        </TooltipProvider>
      )}

      {missingIds.map((id) => (
        <Badge key={id} variant="outline" className="gap-1 font-mono">
          {id.slice(0, 8)}
          <button
            type="button"
            aria-label={`${t('common:actions.remove')} ${id.slice(0, 8)}`}
            className="hover:bg-muted-foreground/20 text-muted-foreground hover:text-destructive rounded-full p-0.5"
            onClick={() => onChange(value.filter((v) => v !== id))}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}

      {addButton}

      {addOpen && (
        <DestinationDialog
          open
          onOpenChange={setAddOpen}
          mode="create"
          onCreated={(created) => onChange([...value, created.id])}
        />
      )}
    </div>
  );
}
