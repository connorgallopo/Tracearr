import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import {
  NEWSLETTER_MOST_WATCHED_MAX,
  NEWSLETTER_SEASONS_PER_SHOW_MAX,
  NEWSLETTER_SECTION_MAX,
  NEWSLETTER_WINDOW_MAX_DAYS,
  type NewsletterSections,
  type NewsletterWindow,
} from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  INPUT_GROUP_UNIT,
  InputGroup,
  InputGroupAddon,
  InputGroupText,
} from '@/components/ui/input-group';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';
import { NumericInput } from '@/components/ui/numeric-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useLibraries, useServers } from '@/hooks/queries';
import { NEWSLETTER_FIELD_IDS, type FieldsetProps } from './newsletterForm';

const SECTIONS = ['movies', 'shows', 'music', 'mostWatched'] as const;
const CAP: Record<(typeof SECTIONS)[number], number> = {
  movies: NEWSLETTER_SECTION_MAX,
  shows: NEWSLETTER_SECTION_MAX,
  music: NEWSLETTER_SECTION_MAX,
  mostWatched: NEWSLETTER_MOST_WATCHED_MAX,
};

const windowDays = (window: NewsletterWindow) =>
  window.kind === 'fixed' ? window.days : window.fallbackDays;

export function ContentFields({ state, onChange, errors }: FieldsetProps) {
  const { t } = useTranslation('settings');
  const { data: servers } = useServers();
  const { data: libraries, isLoading: librariesLoading } = useLibraries(state.scope.serverIds);
  const { scope, sections, window } = state;

  const serverOptions: MultiSelectOption[] = (servers ?? []).map((server) => ({
    value: server.id,
    label: server.name,
  }));
  // The scope stores bare library ids; an id two servers share is one option, so the label names the first.
  const libraryOptions = useMemo(() => {
    const byId = new Map<string, MultiSelectOption>();
    for (const library of libraries?.data ?? []) {
      if (!byId.has(library.libraryId))
        byId.set(library.libraryId, {
          value: library.libraryId,
          label: library.name,
          group: library.serverName,
        });
    }
    return [...byId.values()];
  }, [libraries]);
  const known = new Set(libraryOptions.map((option) => option.value));
  const unknownLibraries = librariesLoading ? [] : scope.libraryIds.filter((id) => !known.has(id));

  const setWindow = (next: NewsletterWindow) => onChange({ window: next });
  const setSection = <K extends keyof NewsletterSections>(
    key: K,
    patch: Partial<NewsletterSections[K]>
  ) => onChange({ sections: { ...sections, [key]: { ...sections[key], ...patch } } });

  return (
    <FieldSet>
      <FieldLegend>{t('newsletters.editor.content')}</FieldLegend>
      <div className="flex flex-wrap gap-4">
        <Field className="w-56">
          <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.windowKind}>
            {t('newsletters.editor.windowKind')}
          </FieldLabel>
          <Select
            value={window.kind}
            onValueChange={(kind) =>
              setWindow(
                kind === 'fixed'
                  ? { kind: 'fixed', days: windowDays(window) }
                  : { kind: 'since_last_send', fallbackDays: windowDays(window) }
              )
            }
          >
            <SelectTrigger
              id={NEWSLETTER_FIELD_IDS.windowKind}
              aria-label={t('newsletters.editor.windowKind')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="since_last_send">
                {t('newsletters.editor.windows.since_last_send')}
              </SelectItem>
              <SelectItem value="fixed">{t('newsletters.editor.windows.fixed')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-44">
          <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.windowDays}>
            {window.kind === 'fixed'
              ? t('newsletters.editor.windowDays')
              : t('newsletters.editor.fallbackDays')}
          </FieldLabel>
          <InputGroup>
            <NumericInput
              id={NEWSLETTER_FIELD_IDS.windowDays}
              data-slot="input-group-control"
              className="min-w-0 flex-1 rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
              value={windowDays(window)}
              min={1}
              max={NEWSLETTER_WINDOW_MAX_DAYS}
              onChange={(days) =>
                setWindow(
                  window.kind === 'fixed'
                    ? { kind: 'fixed', days }
                    : { kind: 'since_last_send', fallbackDays: days }
                )
              }
            />
            <InputGroupAddon align="inline-end" className={INPUT_GROUP_UNIT}>
              <InputGroupText>{t('newsletters.editor.days')}</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
        </Field>
      </div>
      <FieldError>{errors.window}</FieldError>
      <Field className="max-w-sm">
        <FieldLabel id={`${NEWSLETTER_FIELD_IDS.servers}-label`}>
          {t('newsletters.editor.servers')}
        </FieldLabel>
        <MultiSelect
          id={NEWSLETTER_FIELD_IDS.servers}
          aria-labelledby={`${NEWSLETTER_FIELD_IDS.servers}-label`}
          options={serverOptions}
          value={scope.serverIds}
          onChange={(serverIds) => onChange({ scope: { ...scope, serverIds } })}
          placeholder={t('newsletters.editor.allServers')}
          searchPlaceholder={t('newsletters.editor.searchServers')}
          emptyMessage={t('newsletters.editor.noServers')}
          clearLabel={t('newsletters.editor.clear')}
          countLabel={(count) => t('newsletters.editor.serversSelected', { count })}
        />
      </Field>
      <Field className="max-w-sm">
        <FieldLabel id={`${NEWSLETTER_FIELD_IDS.libraries}-label`}>
          {t('newsletters.editor.libraries')}
        </FieldLabel>
        <MultiSelect
          id={NEWSLETTER_FIELD_IDS.libraries}
          aria-labelledby={`${NEWSLETTER_FIELD_IDS.libraries}-label`}
          options={libraryOptions}
          value={scope.libraryIds}
          onChange={(libraryIds) => onChange({ scope: { ...scope, libraryIds } })}
          placeholder={t('newsletters.editor.allLibraries')}
          searchPlaceholder={t('newsletters.editor.searchLibraries')}
          emptyMessage={t('newsletters.editor.noLibraries')}
          clearLabel={t('newsletters.editor.clear')}
          countLabel={(count) => t('newsletters.editor.librariesSelected', { count })}
        />
        {unknownLibraries.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {unknownLibraries.map((id) => (
              <Badge key={id} variant="outline" title={id}>
                {t('newsletters.editor.unknownLibrary')}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('newsletters.editor.removeLibrary', { id })}
                  onClick={() =>
                    onChange({
                      scope: { ...scope, libraryIds: scope.libraryIds.filter((x) => x !== id) },
                    })
                  }
                >
                  <X />
                </Button>
              </Badge>
            ))}
          </div>
        )}
        <FieldError>{errors.scope}</FieldError>
      </Field>
      <div className="flex flex-col gap-3">
        {SECTIONS.map((section) => {
          const label = t(`newsletters.editor.sections.${section}`);
          const capId = `${NEWSLETTER_FIELD_IDS.name}-cap-${section}`;
          return (
            <Field key={section} orientation="horizontal" className="flex-wrap">
              <Switch
                checked={sections[section].enabled}
                onCheckedChange={(enabled) => setSection(section, { enabled })}
                aria-label={label}
              />
              <FieldContent>
                <FieldLabel htmlFor={capId}>{label}</FieldLabel>
              </FieldContent>
              <NumericInput
                id={capId}
                className="w-20"
                aria-label={t('newsletters.editor.sectionMax', { section: label })}
                value={sections[section].max}
                min={1}
                max={CAP[section]}
                onChange={(max) => setSection(section, { max })}
              />
              {section === 'shows' && (
                <NumericInput
                  className="w-20"
                  aria-label={t('newsletters.editor.seasonsPerShow')}
                  value={sections.shows.maxSeasonsPerShow}
                  min={1}
                  max={NEWSLETTER_SEASONS_PER_SHOW_MAX}
                  onChange={(maxSeasonsPerShow) => setSection('shows', { maxSeasonsPerShow })}
                />
              )}
            </Field>
          );
        })}
        <FieldDescription>{t('newsletters.editor.sectionsHelp')}</FieldDescription>
        <FieldError>{errors.sections}</FieldError>
      </div>
    </FieldSet>
  );
}
