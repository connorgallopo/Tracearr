import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Save } from 'lucide-react';
import { emailBrandingSchema, type EmailBrandingSettings } from '@tracearr/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { BindingDoors } from '@/components/ui/form-doors';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useEmailBranding, useSaveEmailBranding } from '@/hooks/queries';
import { deepEqual } from './newsletter/newsletterForm';

const LOGO_MODES = ['tracearr', 'none', 'url'] as const;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** PUT /email/branding replaces the block, so the form edits a copy of what it read and sends all of it. */
function BrandingFields({ stored }: { stored: EmailBrandingSettings }) {
  const { t } = useTranslation('settings');
  const save = useSaveEmailBranding();
  const [seed, setSeed] = useState(stored);
  const [state, setState] = useState(stored);
  const [logoUrl, setLogoUrl] = useState(stored.logo.mode === 'url' ? stored.logo.url : '');
  const errors: Partial<Record<'accentColor' | 'logo', string>> = {};
  const parsed = emailBrandingSchema.safeParse(state);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if ((key === 'accentColor' || key === 'logo') && errors[key] === undefined)
        errors[key] = issue.message;
    }
  }
  const dirty = !deepEqual(seed, state);
  const valid = parsed.success;
  const patch = (next: Partial<EmailBrandingSettings>) =>
    setState((current) => ({ ...current, ...next }));
  const setMode = (mode: (typeof LOGO_MODES)[number]) =>
    patch({ logo: mode === 'url' ? { mode, url: logoUrl } : { mode } });

  return (
    <FieldGroup className="gap-6">
      <Field>
        <FieldLabel id="branding-logo-label">{t('email.branding.logo.label')}</FieldLabel>
        <RadioGroup
          value={state.logo.mode}
          onValueChange={(mode) => setMode(mode as (typeof LOGO_MODES)[number])}
          aria-labelledby="branding-logo-label"
        >
          {LOGO_MODES.map((mode) => (
            <div key={mode} className="flex items-center gap-2">
              <RadioGroupItem
                id={`branding-logo-mode-${mode}`}
                value={mode}
                aria-label={t(`email.branding.logo.${mode}`)}
              />
              <FieldLabel htmlFor={`branding-logo-mode-${mode}`}>
                {t(`email.branding.logo.${mode}`)}
              </FieldLabel>
            </div>
          ))}
        </RadioGroup>
        {state.logo.mode === 'url' && (
          <Field className="max-w-sm" data-invalid={errors.logo !== undefined}>
            <FieldLabel htmlFor="branding-logo-url">{t('email.branding.logoUrl')}</FieldLabel>
            <Input
              id="branding-logo-url"
              type="url"
              value={logoUrl}
              aria-invalid={errors.logo !== undefined}
              onChange={(event) => {
                setLogoUrl(event.target.value);
                patch({ logo: { mode: 'url', url: event.target.value } });
              }}
            />
            <FieldError>{errors.logo}</FieldError>
          </Field>
        )}
      </Field>
      <Field className="max-w-xs" data-invalid={errors.accentColor !== undefined}>
        <FieldLabel htmlFor="branding-accent">{t('email.branding.accent')}</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id="branding-accent"
            value={state.accentColor}
            maxLength={7}
            aria-invalid={errors.accentColor !== undefined}
            onChange={(event) => patch({ accentColor: event.target.value })}
          />
          <InputGroupAddon align="inline-end">
            <input
              type="color"
              aria-label={t('email.branding.accentPicker')}
              value={HEX.test(state.accentColor) ? state.accentColor : '#000000'}
              className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
              onChange={(event) => patch({ accentColor: event.target.value })}
            />
          </InputGroupAddon>
        </InputGroup>
        <FieldError>{errors.accentColor}</FieldError>
      </Field>
      <Field>
        <FieldLabel htmlFor="branding-footer">{t('email.branding.footerText')}</FieldLabel>
        <Textarea
          id="branding-footer"
          rows={2}
          maxLength={500}
          value={state.footerText ?? ''}
          onChange={(event) =>
            patch({ footerText: event.target.value === '' ? null : event.target.value })
          }
        />
        <FieldDescription>{t('email.branding.footerTextHelp')}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="branding-postal">{t('email.branding.postalAddress')}</FieldLabel>
        <Textarea
          id="branding-postal"
          rows={2}
          maxLength={500}
          value={state.postalAddress ?? ''}
          onChange={(event) =>
            patch({ postalAddress: event.target.value === '' ? null : event.target.value })
          }
        />
        <FieldDescription>{t('email.branding.postalAddressHelp')}</FieldDescription>
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="branding-mailto">{t('email.branding.mailto')}</FieldLabel>
          <FieldDescription>{t('email.branding.mailtoHelp')}</FieldDescription>
        </FieldContent>
        <Switch
          id="branding-mailto"
          checked={state.mailtoUnsubscribe}
          onCheckedChange={(mailtoUnsubscribe) => patch({ mailtoUnsubscribe })}
          aria-label={t('email.branding.mailto')}
        />
      </Field>
      <BindingDoors
        primaryLabel={save.isPending ? t('email.branding.saving') : t('email.branding.save')}
        primaryIcon={save.isPending ? <Loader2 className="animate-spin" /> : <Save />}
        pending={save.isPending}
        disabled={!valid || !dirty}
        status={
          dirty ? (
            <span className="text-muted-foreground flex items-center gap-2 text-sm">
              <span className="bg-primary size-1.5 rounded-full" />
              {t('newsletters.editor.unsaved')}
            </span>
          ) : null
        }
        onPrimary={() => {
          if (!parsed.success) return;
          save.mutate(parsed.data, {
            onSuccess: (saved) => {
              setSeed(saved);
              setState(saved);
            },
          });
        }}
      />
    </FieldGroup>
  );
}

export function BrandingForm() {
  const { t } = useTranslation('settings');
  const { data, isLoading, isError, error } = useEmailBranding();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('email.branding.title')}</CardTitle>
        <CardDescription>{t('email.branding.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton data-testid="branding-loading" className="h-64 w-full" />}
        {isError && (
          <Alert variant="destructive">
            <AlertDescription>{error?.message}</AlertDescription>
          </Alert>
        )}
        {data && <BrandingFields key={JSON.stringify(data)} stored={data} />}
      </CardContent>
    </Card>
  );
}
