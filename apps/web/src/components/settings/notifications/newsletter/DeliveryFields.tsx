import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Plus } from 'lucide-react';
import { NEWSLETTER_IMAGE_MODES } from '@tracearr/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DestinationDialog } from '@/components/settings/destinations/DestinationDialog';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useDestinations, useSettings } from '@/hooks/queries';
import type { FieldsetProps } from './newsletterForm';

const NONE = '__none__';

export function DeliveryFields({ state, onChange, errors }: FieldsetProps) {
  const { t } = useTranslation('settings');
  const { data: destinations } = useDestinations();
  const { data: settings } = useSettings();
  const emailDestinations = (destinations ?? []).filter((d) => d.type === 'email');
  const hostedWithoutUrl = state.imageMode === 'hosted' && !settings?.externalUrl;
  const [addOpen, setAddOpen] = useState(false);

  return (
    <FieldSet>
      <FieldLegend>{t('newsletters.editor.delivery.title')}</FieldLegend>
      <Field className="max-w-sm" data-invalid={errors.destinationId !== undefined}>
        <FieldLabel htmlFor="newsletter-destination">
          {t('newsletters.editor.delivery.destination')}
        </FieldLabel>
        {emailDestinations.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <FieldDescription>{t('newsletters.noDestinationHint')}</FieldDescription>
            <Button type="button" variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              <Plus />
              {t('newsletters.addEmailDestination')}
            </Button>
          </div>
        ) : (
          <Select
            value={state.destinationId ?? undefined}
            onValueChange={(value) => onChange({ destinationId: value === NONE ? null : value })}
          >
            <SelectTrigger
              id="newsletter-destination"
              aria-label={t('newsletters.editor.delivery.destination')}
            >
              <SelectValue placeholder={t('newsletters.editor.delivery.pickDestination')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('newsletters.editor.delivery.noDestination')}</SelectItem>
              {emailDestinations.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <FieldError>{errors.destinationId}</FieldError>
      </Field>
      <Field className="max-w-sm">
        <FieldLabel htmlFor="newsletter-image-mode">
          {t('newsletters.editor.delivery.imageMode')}
        </FieldLabel>
        <Select
          value={state.imageMode}
          onValueChange={(imageMode) =>
            onChange({ imageMode: imageMode as (typeof NEWSLETTER_IMAGE_MODES)[number] })
          }
        >
          <SelectTrigger
            id="newsletter-image-mode"
            aria-label={t('newsletters.editor.delivery.imageMode')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NEWSLETTER_IMAGE_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {t(`newsletters.editor.delivery.modes.${mode}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          {t(`newsletters.editor.delivery.modeHelp.${state.imageMode}`)}
        </FieldDescription>
        {hostedWithoutUrl && (
          <Alert variant="warning">
            <AlertTriangle />
            <AlertDescription>{t('newsletters.editor.delivery.hostedNeedsUrl')}</AlertDescription>
          </Alert>
        )}
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="newsletter-skip-empty">
            {t('newsletters.editor.delivery.skipWhenEmpty')}
          </FieldLabel>
          <FieldDescription>{t('newsletters.editor.delivery.skipWhenEmptyHelp')}</FieldDescription>
        </FieldContent>
        <Switch
          id="newsletter-skip-empty"
          checked={state.skipWhenEmpty}
          onCheckedChange={(skipWhenEmpty) => onChange({ skipWhenEmpty })}
          aria-label={t('newsletters.editor.delivery.skipWhenEmpty')}
        />
      </Field>
      {addOpen && (
        <DestinationDialog
          open
          onOpenChange={setAddOpen}
          mode="create"
          initialKind="email"
          onCreated={(created) => onChange({ destinationId: created.id })}
        />
      )}
    </FieldSet>
  );
}
