import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Info, Loader2, Save } from 'lucide-react';
import type { Newsletter } from '@tracearr/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { BindingDoors } from '@/components/ui/form-doors';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { RichTextChange } from '@/components/ui/rich-text-normalize';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { useNewsletter, useNewsletterRecipients, useServers } from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges';
import { ContentFields } from './ContentFields';
import { DeliveryFields } from './DeliveryFields';
import { IdentityFields } from './IdentityFields';
import { MessageFields } from './MessageFields';
import { NewsletterActions, type NewsletterActionsHandle } from './NewsletterActions';
import { NEWSLETTERS_PATH } from '../Newsletters';
import { scheduleSummary, type Translate } from '../newsletterFormat';
import { ReadinessList, recipientsState } from './ReadinessList';
import { RecipientsFields } from './RecipientsFields';
import { ScheduleFields } from './ScheduleFields';
import { SendHistory } from './SendHistory';
import { useNewsletterSave } from './useNewsletterSave';
import {
  deepEqual,
  defaultFormState,
  firstInvalidField,
  focusTargetId,
  prefillFromRouterState,
  scopedServers,
  seedFromNewsletter,
  validateForm,
  recipientsQueryId,
  visibleErrors,
  type NewsletterFormState,
  type RichTextErrors,
  type TouchedFields,
} from './newsletterForm';

interface EditorFormProps {
  seed: NewsletterFormState;
  newsletter: Newsletter | null;
}

function EditorForm({ seed: initialSeed, newsletter }: EditorFormProps) {
  const { t, i18n } = useTranslation(['settings', 'common', 'pages']);
  const translate = t as Translate;
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
  const [touched, setTouched] = useState<TouchedFields>({});
  const [submitted, setSubmitted] = useState(false);
  const [redirectTo, setRedirectTo] = useState<string | null>(null);
  const actionsRef = useRef<NewsletterActionsHandle>(null);
  const mode = newsletter ? 'edit' : 'create';
  const { data: servers } = useServers();
  const scopedServerCount = scopedServers(state.scope, servers ?? []).length;
  const errors = validateForm(state, {
    scopedServerCount,
    messages: {
      required: t('common:validation.required'),
      maxLength: (max) => t('common:validation.maxLength', { max }),
      senderNameRequired: t('newsletters.editor.senderNameRequiredMulti', {
        count: scopedServerCount,
      }),
    },
  });
  const valid =
    Object.keys(errors).length === 0 && Object.values(richTextErrors).every((e) => e === undefined);
  const shownErrors = visibleErrors(errors, touched, submitted);
  const touch = (key: keyof NewsletterFormState) =>
    setTouched((prev) => (prev[key] ? prev : { ...prev, [key]: true }));

  const {
    dirty,
    pending,
    save: saveNow,
  } = useNewsletterSave({
    newsletterId: newsletter?.id ?? null,
    seed,
    state,
    valid,
    onSaved: (row, saved) => {
      setSeed(saved);
      setSubmitted(false);
      if (!newsletter) setRedirectTo(`${NEWSLETTERS_PATH}/${row.id}`);
    },
  });
  const blocker = useUnsavedChanges(dirty);
  const { data: recipientsView } = useNewsletterRecipients(
    recipientsQueryId(state.recipients, newsletter?.id ?? null)
  );
  const resolvable = recipientsState(state.recipients, recipientsView);
  const schedule = scheduleSummary(state.schedule, state.timezone, translate, i18n.language);
  const summary = resolvable.known
    ? translate('newsletters.editor.headerSummary', {
        schedule,
        recipients: translate('newsletters.editor.readiness.recipients', {
          count: resolvable.resolvable,
        }),
      })
    : schedule;

  // Once the save has landed the guard is clean, and only then may a fresh row's page move: navigating in the same tick as the save would still see the pre-save dirty flag and block itself.
  useEffect(() => {
    if (redirectTo !== null && !dirty) void navigate(redirectTo, { replace: true });
  }, [redirectTo, dirty, navigate]);

  const onChange = (patch: Partial<NewsletterFormState>) =>
    setState((current) => ({ ...current, ...patch }));
  // A cleared key is removed, not set to undefined: focusFirstInvalid merges these over the Zod errors.
  const onRichText = (field: 'intro' | 'outro', change: RichTextChange) => {
    touch(field);
    setRichTextErrors((current) => {
      const next = { ...current };
      if (change.error === null) delete next[field];
      else next[field] = change.error;
      return next;
    });
    if (change.error === null) onChange({ [field]: change.value });
  };

  const focusFirstInvalid = () => {
    const field = firstInvalidField({ ...errors, ...richTextErrors });
    if (field === null) return;
    const control = document.getElementById(focusTargetId(field, state));
    control?.scrollIntoView({ block: 'center' });
    control?.focus();
  };
  const refuse = () => {
    setSubmitted(true);
    focusFirstInvalid();
  };
  const save = () => {
    if (!valid) {
      refuse();
      return;
    }
    setSubmitted(true);
    saveNow();
  };

  const refused = submitted && !valid;
  const status =
    dirty || refused ? (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {dirty && (
          <span className="text-muted-foreground flex items-center gap-2">
            <span className="bg-primary size-1.5 rounded-full" />
            {t('newsletters.editor.unsaved')}
          </span>
        )}
        {refused && <span className="text-destructive">{t('newsletters.editor.fixFirst')}</span>}
      </span>
    ) : null;

  const cards = (
    <div className="flex min-w-0 flex-col gap-6">
      <IdentityFields
        state={state}
        onChange={onChange}
        errors={shownErrors}
        mode={mode}
        touch={touch}
        touched={touched}
      />
      <ScheduleFields
        state={state}
        onChange={onChange}
        errors={shownErrors}
        mode={mode}
        touch={touch}
        touched={touched}
        nextRunAt={newsletter?.nextRunAt}
        scheduleDirty={
          !deepEqual(seed.schedule, state.schedule) || seed.timezone !== state.timezone
        }
      />
      <ContentFields
        state={state}
        onChange={onChange}
        errors={shownErrors}
        mode={mode}
        touch={touch}
        touched={touched}
      />
      <MessageFields
        state={state}
        onChange={onChange}
        errors={shownErrors}
        mode={mode}
        touch={touch}
        touched={touched}
        richTextErrors={richTextErrors}
        onRichText={onRichText}
        fieldKey={newsletter?.id ?? 'new'}
      />
      <RecipientsFields
        state={state}
        onChange={onChange}
        errors={shownErrors}
        mode={mode}
        touch={touch}
        touched={touched}
        newsletterId={newsletter?.id ?? null}
        savedServerIds={newsletter ? seed.scope.serverIds : null}
        onPreview={() => actionsRef.current?.openPreview()}
      />
      <DeliveryFields
        state={state}
        onChange={onChange}
        errors={shownErrors}
        mode={mode}
        touch={touch}
        touched={touched}
      />
    </div>
  );

  const form = (
    <div className="@container/editor flex flex-col gap-6">
      <div className="grid items-start gap-6 @4xl/editor:grid-cols-[minmax(0,1fr)_18rem]">
        {cards}
        <aside className="@4xl/editor:sticky @4xl/editor:top-6">
          <ReadinessList
            state={state}
            newsletterId={newsletter?.id ?? null}
            savedServerIds={newsletter ? seed.scope.serverIds : null}
          />
        </aside>
      </div>
      <BindingDoors
        className="bg-background/95 sticky bottom-0 z-10 border-t pt-4 pb-3 backdrop-blur"
        primaryLabel={pending ? t('newsletters.editor.saving') : t('newsletters.editor.save')}
        primaryIcon={pending ? <Loader2 className="animate-spin" /> : <Save />}
        pending={pending}
        disabled={!dirty}
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
    </div>
  );

  return (
    <SettingsSection
      title={newsletter ? newsletter.name : t('newsletters.editor.newTitle')}
      description={summary}
      actions={
        <NewsletterActions
          ref={actionsRef}
          newsletter={newsletter}
          state={state}
          dirty={dirty}
          valid={valid}
          onRefuse={refuse}
        />
      }
    >
      <Tabs value={newsletter ? activeTab : 'edit'} onValueChange={onTabChange} className="gap-6">
        <div className="border-b">
          <TabsList variant="line" className="-mb-px">
            <TabsTrigger value="edit">{t('newsletters.editor.tabs.edit')}</TabsTrigger>
            {newsletter ? (
              <TabsTrigger value="history">{t('newsletters.editor.tabs.history')}</TabsTrigger>
            ) : (
              <TooltipProvider delayDuration={100}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <TabsTrigger value="history" disabled>
                        {t('newsletters.editor.tabs.history')}
                      </TabsTrigger>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{t('newsletters.editor.historyNeedsSave')}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </TabsList>
        </div>
        <TabsContent value="edit">{form}</TabsContent>
        {newsletter && (
          <TabsContent value="history">
            <SendHistory newsletterId={newsletter.id} timezone={newsletter.timezone} />
          </TabsContent>
        )}
      </Tabs>
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
