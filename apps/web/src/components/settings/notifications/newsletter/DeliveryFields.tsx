import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Info, Plus } from 'lucide-react';
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
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useDestinations, useSettings } from '@/hooks/queries';
import { EditorCard } from './EditorCard';
import { NEWSLETTER_FIELD_IDS, type FieldsetProps } from './newsletterForm';

const NONE = '__none__';

export function DeliveryFields({ state, onChange, errors, mode, touch, touched }: FieldsetProps) {
  const { t } = useTranslation('settings');
  const { data: destinations, isLoading, isError, error } = useDestinations();
  const { data: settings } = useSettings();
  const emailDestinations = (destinations ?? []).filter((d) => d.type === 'email');
  const hostedWithoutUrl = state.imageMode === 'hosted' && !settings?.externalUrl;
  const [addOpen, setAddOpen] = useState(false);

  return (
    <EditorCard title={t('newsletters.editor.delivery.title')}>
      <Field className="max-w-sm" data-invalid={errors.destinationId !== undefined}>
        <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.destination}>
          {t('newsletters.editor.delivery.destination')}
        </FieldLabel>
        {isLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : isError ? (
          <Alert variant="destructive">
            <Info />
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : emailDestinations.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <FieldDescription>{t('newsletters.noDestinationHint')}</FieldDescription>
            <Button type="button" variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              <Plus />
              {t('newsletters.addEmailDestination')}
            </Button>
          </div>
        ) : (
          <Select
            /* A never-touched create form shows the placeholder; a saved row's cleared destination, or one this form already touched, shows None. */
            value={
              state.destinationId ?? (mode === 'edit' || touched.destinationId ? NONE : undefined)
            }
            onValueChange={(value) => {
              touch('destinationId');
              onChange({ destinationId: value === NONE ? null : value });
            }}
          >
            <SelectTrigger
              id={NEWSLETTER_FIELD_IDS.destination}
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
        <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.imageMode}>
          {t('newsletters.editor.delivery.imageMode')}
        </FieldLabel>
        <Select
          value={state.imageMode}
          onValueChange={(imageMode) => {
            touch('imageMode');
            onChange({ imageMode: imageMode as (typeof NEWSLETTER_IMAGE_MODES)[number] });
          }}
        >
          <SelectTrigger
            id={NEWSLETTER_FIELD_IDS.imageMode}
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
          <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.skipWhenEmpty}>
            {t('newsletters.editor.delivery.skipWhenEmpty')}
          </FieldLabel>
          <FieldDescription>{t('newsletters.editor.delivery.skipWhenEmptyHelp')}</FieldDescription>
        </FieldContent>
        <Switch
          id={NEWSLETTER_FIELD_IDS.skipWhenEmpty}
          checked={state.skipWhenEmpty}
          onCheckedChange={(skipWhenEmpty) => onChange({ skipWhenEmpty })}
          aria-label={t('newsletters.editor.delivery.skipWhenEmpty')}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.linksTracearr}>
            {t('newsletters.editor.links.tracearr')}
          </FieldLabel>
          <FieldDescription>{t('newsletters.editor.links.tracearrNote')}</FieldDescription>
        </FieldContent>
        <Switch
          id={NEWSLETTER_FIELD_IDS.linksTracearr}
          checked={state.links.tracearr}
          onCheckedChange={(tracearr) => onChange({ links: { tracearr } })}
          aria-label={t('newsletters.editor.links.tracearr')}
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
    </EditorCard>
  );
}
