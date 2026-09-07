import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Info, Loader2, Save } from 'lucide-react';
import type { Newsletter } from '@tracearr/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FieldGroup } from '@/components/ui/field';
import { BindingDoors } from '@/components/ui/form-doors';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { RichTextChange } from '@/components/ui/rich-text-normalize';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { useNewsletter } from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges';
import { ContentFields } from './ContentFields';
import { DeliveryFields } from './DeliveryFields';
import { IdentityFields } from './IdentityFields';
import { LinksFields } from './LinksFields';
import { MessageFields } from './MessageFields';
import { NewsletterActions } from './NewsletterActions';
import { NEWSLETTERS_PATH } from '../Newsletters';
import { ReadinessList } from './ReadinessList';
import { RecipientsFields } from './RecipientsFields';
import { ScheduleFields } from './ScheduleFields';
import { SendHistory } from './SendHistory';
import { useNewsletterSave } from './useNewsletterSave';
import {
  defaultFormState,
  prefillFromRouterState,
  seedFromNewsletter,
  validateForm,
  type NewsletterFormState,
  type RichTextErrors,
} from './newsletterForm';

interface EditorFormProps {
  seed: NewsletterFormState;
  newsletter: Newsletter | null;
}

function EditorForm({ seed: initialSeed, newsletter }: EditorFormProps) {
  const { t } = useTranslation(['settings', 'common', 'pages']);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') === 'history' ? 'history' : 'edit';
  const onTabChange = (tab: string) => {
    const next = new URLSearchParams(searchParams);
    if (tab === 'history') next.set('tab', 'history');
    else next.delete('tab');
    setSearchParams(next, { replace: true });
  };
  const [seed, setSeed] = useState<NewsletterFormState>(initialSeed);
  const [state, setState] = useState<NewsletterFormState>(initialSeed);
  const [richTextErrors, setRichTextErrors] = useState<RichTextErrors>({});
  const [redirectTo, setRedirectTo] = useState<string | null>(null);
  const mode = newsletter ? 'edit' : 'create';
  const errors = validateForm(state);
  const valid =
    Object.keys(errors).length === 0 && Object.values(richTextErrors).every((e) => e === undefined);

  const { dirty, pending, save, saveThen } = useNewsletterSave({
    newsletterId: newsletter?.id ?? null,
    seed,
    state,
    valid,
    onSaved: (row, saved) => {
      setSeed(saved);
      if (!newsletter) setRedirectTo(`${NEWSLETTERS_PATH}/${row.id}`);
    },
  });
  const blocker = useUnsavedChanges(dirty);

  // Once the save has landed the guard is clean, and only then may a fresh row's page move: navigating in the same tick as the save would still see the pre-save dirty flag and block itself.
  useEffect(() => {
    if (redirectTo !== null && !dirty) void navigate(redirectTo, { replace: true });
  }, [redirectTo, dirty, navigate]);

  const onChange = (patch: Partial<NewsletterFormState>) =>
    setState((current) => ({ ...current, ...patch }));
  const onRichText = (field: 'intro' | 'outro', change: RichTextChange) => {
    setRichTextErrors((current) => ({ ...current, [field]: change.error ?? undefined }));
    if (change.error === null) onChange({ [field]: change.value });
  };

  const status = dirty ? (
    <span className="text-muted-foreground flex items-center gap-2 text-sm">
      <span className="bg-primary size-1.5 rounded-full" />
      {t('newsletters.editor.unsaved')}
    </span>
  ) : null;

  const form = (
    <FieldGroup className="gap-8">
      <IdentityFields state={state} onChange={onChange} errors={errors} mode={mode} />
      <ScheduleFields
        state={state}
        onChange={onChange}
        errors={errors}
        mode={mode}
        nextRunAt={newsletter?.nextRunAt}
      />
      <ContentFields state={state} onChange={onChange} errors={errors} mode={mode} />
      <MessageFields
        state={state}
        onChange={onChange}
        errors={errors}
        mode={mode}
        richTextErrors={richTextErrors}
        onRichText={onRichText}
        fieldKey={newsletter?.id ?? 'new'}
      />
      <RecipientsFields
        state={state}
        onChange={onChange}
        errors={errors}
        mode={mode}
        newsletterId={newsletter?.id ?? null}
      />
      <DeliveryFields state={state} onChange={onChange} errors={errors} mode={mode} />
      <LinksFields state={state} onChange={onChange} errors={errors} mode={mode} />
      <ReadinessList state={state} newsletterId={newsletter?.id ?? null} />
      <BindingDoors
        className="bg-background/95 sticky bottom-0 z-10 border-t pt-4 pb-3 backdrop-blur"
        primaryLabel={pending ? t('newsletters.editor.saving') : t('newsletters.editor.save')}
        primaryIcon={pending ? <Loader2 className="animate-spin" /> : <Save />}
        pending={pending}
        disabled={!valid || !dirty}
        status={status}
        onPrimary={save}
      />
      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
        title={t('pages:automations.builder.leave.title')}
        description={t('common:confirmations.unsavedChanges')}
        confirmLabel={t('pages:automations.builder.leave.confirm')}
        cancelLabel={t('common:actions.cancel')}
        onConfirm={() => blocker.proceed?.()}
      />
    </FieldGroup>
  );

  return (
    <SettingsSection
      title={newsletter ? newsletter.name : t('newsletters.editor.newTitle')}
      actions={
        newsletter ? (
          <NewsletterActions newsletter={newsletter} dirty={dirty} saveThen={saveThen} />
        ) : null
      }
    >
      {newsletter ? (
        <Tabs value={activeTab} onValueChange={onTabChange}>
          <TabsList>
            <TabsTrigger value="edit">{t('newsletters.editor.tabs.edit')}</TabsTrigger>
            <TabsTrigger value="history">{t('newsletters.editor.tabs.history')}</TabsTrigger>
          </TabsList>
          <TabsContent value="edit">{form}</TabsContent>
          <TabsContent value="history">
            <SendHistory newsletterId={newsletter.id} timezone={newsletter.timezone} />
          </TabsContent>
        </Tabs>
      ) : (
        form
      )}
    </SettingsSection>
  );
}

export function NewsletterEditor() {
  const { t } = useTranslation('settings');
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const { user } = useAuth();
  const { data: newsletter, isLoading, isError, error } = useNewsletter(id);

  if (user?.role !== 'owner') {
    return (
      <SettingsSection title={t('nav.sections.newsletters')}>
        <Alert>
          <Info />
          <AlertDescription>{t('newsletters.ownerOnly')}</AlertDescription>
        </Alert>
      </SettingsSection>
    );
  }
  if (id && isLoading) {
    return (
      <SettingsSection title={t('nav.sections.newsletters')}>
        <Skeleton data-testid="newsletter-editor-loading" className="h-[40rem] w-full" />
      </SettingsSection>
    );
  }
  if (id && (isError || !newsletter)) {
    return (
      <SettingsSection title={t('nav.sections.newsletters')}>
        <Alert variant="destructive">
          <Info />
          <AlertDescription>{error?.message ?? t('newsletters.editor.notFound')}</AlertDescription>
        </Alert>
      </SettingsSection>
    );
  }

  const row = id ? (newsletter ?? null) : null;
  // The form owns its state from the seed; a different row remounts it.
  return (
    <EditorForm
      key={row?.id ?? 'new'}
      seed={
        row
          ? seedFromNewsletter(row)
          : { ...defaultFormState(), ...prefillFromRouterState(location.state) }
      }
      newsletter={row}
    />
  );
}
