import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import {
  NEWSLETTER_MOST_WATCHED_MAX,
  NEWSLETTER_SEASONS_PER_SHOW_MAX,
  NEWSLETTER_SECTION_MAX,
  NEWSLETTER_WINDOW_MAX_DAYS,
  type NewsletterScopeLibrary,
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
  INPUT_GROUP_CONTROL,
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
import { cn } from '@/lib/utils';
import { EditorCard } from './EditorCard';
import { NEWSLETTER_FIELD_IDS, scopedServers, type FieldsetProps } from './newsletterForm';

const windowDays = (window: NewsletterWindow) =>
  window.kind === 'fixed' ? window.days : window.fallbackDays;

const pairKey = (pair: NewsletterScopeLibrary): string => `${pair.serverId}:${pair.libraryId}`;

/** A number inside a sentence: the box carries its unit, and the label repeats the whole sentence for a screen reader. */
function UnitInput({
  id,
  label,
  unit,
  value,
  min,
  max,
  disabled = false,
  onChange,
  onBlur,
}: {
  id: string;
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  onBlur: () => void;
}) {
  return (
    <InputGroup className="w-40" data-disabled={disabled}>
      <NumericInput
        id={id}
        data-slot="input-group-control"
        className={cn('flex-1', INPUT_GROUP_CONTROL)}
        aria-label={label}
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={onChange}
        onBlur={onBlur}
      />
      <InputGroupAddon align="inline-end" className={INPUT_GROUP_UNIT}>
        <InputGroupText>{unit}</InputGroupText>
      </InputGroupAddon>
    </InputGroup>
  );
}

/** A switch, the section name, and the sentence holding its numbers, all on one wrapping row; help drops to a line of its own. */
function SectionRow({
  label,
  htmlFor,
  enabled,
  onToggle,
  help,
  children,
}: {
  label: string;
  htmlFor: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  help?: string;
  children: ReactNode;
}) {
  return (
    <Field orientation="horizontal" className="flex-wrap">
      <Switch checked={enabled} onCheckedChange={onToggle} aria-label={label} />
      <FieldContent className="flex-row flex-wrap items-center gap-x-3 gap-y-2">
        <FieldLabel htmlFor={htmlFor} className={cn(!enabled && 'text-muted-foreground')}>
          {label}
        </FieldLabel>
        <span
          aria-disabled={!enabled}
          className={cn(
            'flex flex-wrap items-center gap-2 text-sm',
            !enabled && 'text-muted-foreground'
          )}
        >
          {children}
        </span>
        {help && <FieldDescription className="basis-full">{help}</FieldDescription>}
      </FieldContent>
    </Field>
  );
}

export function ContentFields({ state, onChange, errors, touch }: FieldsetProps) {
  const { t } = useTranslation('settings');
  const { data: servers } = useServers();
  const { data: libraries, isLoading: librariesLoading } = useLibraries(state.scope.serverIds);
  const { scope, sections, window } = state;
  const scoped = scopedServers(scope, servers ?? []);
  const days = windowDays(window);

  const serverOptions: MultiSelectOption[] = (servers ?? []).map((server) => ({
    value: server.id,
    label: server.name,
  }));
  const libraryOptions = useMemo<MultiSelectOption[]>(
    () =>
      (libraries?.data ?? []).map((library) => ({
        value: pairKey(library),
        label: library.name,
        group: library.serverName,
      })),
    [libraries]
  );
  // Keys map back to pairs through this table, so a pair the picker no longer lists survives a toggle of another one.
  const pairsByKey = useMemo(() => {
    const map = new Map<string, NewsletterScopeLibrary>();
    for (const library of libraries?.data ?? [])
      map.set(pairKey(library), { serverId: library.serverId, libraryId: library.libraryId });
    for (const pair of scope.libraries) map.set(pairKey(pair), pair);
    return map;
  }, [libraries, scope.libraries]);
  const known = new Set(libraryOptions.map((option) => option.value));
  const unknownLibraries = librariesLoading
    ? []
    : scope.libraries.filter((pair) => !known.has(pairKey(pair)));
  const setLibraries = (next: NewsletterScopeLibrary[]) => {
    touch('scope');
    onChange({ scope: { ...scope, libraries: next } });
  };

  const setWindow = (next: NewsletterWindow) => {
    touch('window');
    onChange({ window: next });
  };
  const setDays = (value: number) =>
    setWindow(
      window.kind === 'fixed'
        ? { kind: 'fixed', days: value }
        : { kind: 'since_last_send', fallbackDays: value }
    );
  const setSection = <K extends keyof NewsletterSections>(
    key: K,
    patch: Partial<NewsletterSections[K]>
  ) => {
    touch('sections');
    onChange({ sections: { ...sections, [key]: { ...sections[key], ...patch } } });
  };
  const capId = (section: string) => `${NEWSLETTER_FIELD_IDS.sectionCap}-${section}`;
  const touchSections = () => touch('sections');

  return (
    <EditorCard title={t('newsletters.editor.content')}>
      <Field className="max-w-sm">
        <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.windowKind}>
          {t('newsletters.editor.windowKind')}
        </FieldLabel>
        <Select
          value={window.kind}
          onValueChange={(kind) =>
            setWindow(
              kind === 'fixed'
                ? { kind: 'fixed', days }
                : { kind: 'since_last_send', fallbackDays: days }
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
        <FieldDescription>
          {window.kind === 'fixed'
            ? t('newsletters.editor.windowHelp.fixed')
            : t('newsletters.editor.windowHelp.since_last_send')}
        </FieldDescription>
      </Field>
      <Field>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            {window.kind === 'fixed'
              ? t('newsletters.editor.windowSentence.fixed')
              : t('newsletters.editor.windowSentence.fallback')}
          </span>
          <UnitInput
            id={NEWSLETTER_FIELD_IDS.windowDays}
            label={
              window.kind === 'fixed'
                ? t('newsletters.editor.windowSentence.fixedLabel', { count: days })
                : t('newsletters.editor.windowSentence.fallbackLabel', { count: days })
            }
            unit={t('newsletters.editor.days')}
            value={days}
            min={1}
            max={NEWSLETTER_WINDOW_MAX_DAYS}
            onChange={setDays}
            onBlur={() => touch('window')}
          />
          {window.kind === 'fixed' && (
            <span>{t('newsletters.editor.windowSentence.fixedAfter')}</span>
          )}
        </div>
        <FieldDescription>{t('newsletters.editor.windowMax')}</FieldDescription>
        <FieldError>{errors.window}</FieldError>
      </Field>
      <Field className="max-w-sm">
        <FieldLabel id={`${NEWSLETTER_FIELD_IDS.servers}-label`}>
          {t('newsletters.editor.servers')}
        </FieldLabel>
        <MultiSelect
          id={NEWSLETTER_FIELD_IDS.servers}
          aria-labelledby={`${NEWSLETTER_FIELD_IDS.servers}-label`}
          options={serverOptions}
          value={scope.serverIds}
          onChange={(serverIds) => {
            touch('scope');
            onChange({ scope: { ...scope, serverIds } });
          }}
          placeholder={t('newsletters.editor.allServers')}
          searchPlaceholder={t('newsletters.editor.searchServers')}
          emptyMessage={t('newsletters.editor.noServers')}
          clearLabel={t('newsletters.editor.clear')}
          countLabel={(count) => t('newsletters.editor.serversSelected', { count })}
        />
        {scoped.length > 1 && (
          <FieldDescription>{t('newsletters.editor.variantsNote')}</FieldDescription>
        )}
        {scoped.length === 1 && (
          <FieldDescription>{t('newsletters.editor.serversHelp')}</FieldDescription>
        )}
      </Field>
      <Field className="max-w-sm">
        <FieldLabel id={`${NEWSLETTER_FIELD_IDS.libraries}-label`}>
          {t('newsletters.editor.libraries')}
        </FieldLabel>
        <MultiSelect
          id={NEWSLETTER_FIELD_IDS.libraries}
          aria-labelledby={`${NEWSLETTER_FIELD_IDS.libraries}-label`}
          options={libraryOptions}
          value={scope.libraries.map(pairKey)}
          onChange={(keys) =>
            setLibraries(
              keys.flatMap((key) => {
                const pair = pairsByKey.get(key);
                return pair ? [pair] : [];
              })
            )
          }
          placeholder={t('newsletters.editor.allLibraries')}
          searchPlaceholder={t('newsletters.editor.searchLibraries')}
          emptyMessage={t('newsletters.editor.noLibraries')}
          clearLabel={t('newsletters.editor.clear')}
          countLabel={(count) => t('newsletters.editor.librariesSelected', { count })}
        />
        <FieldDescription>{t('newsletters.editor.librariesHelp')}</FieldDescription>
        {unknownLibraries.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {unknownLibraries.map((pair) => (
              <Badge key={pairKey(pair)} variant="outline" title={pair.libraryId}>
                {t('newsletters.editor.unknownLibrary')}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('newsletters.editor.removeLibrary', { id: pair.libraryId })}
                  onClick={() =>
                    setLibraries(scope.libraries.filter((x) => pairKey(x) !== pairKey(pair)))
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
      <FieldSet className="gap-3">
        <FieldLegend variant="label">{t('newsletters.editor.sections.legend')}</FieldLegend>
        <FieldDescription>{t('newsletters.editor.sections.description')}</FieldDescription>
        <SectionRow
          label={t('newsletters.editor.sections.movies')}
          htmlFor={capId('movies')}
          enabled={sections.movies.enabled}
          onToggle={(enabled) => setSection('movies', { enabled })}
        >
          <span>{t('newsletters.editor.sections.upTo')}</span>
          <UnitInput
            id={capId('movies')}
            label={t('newsletters.editor.sections.labels.movies', { count: sections.movies.max })}
            unit={t('newsletters.editor.sections.units.movies')}
            value={sections.movies.max}
            min={1}
            max={NEWSLETTER_SECTION_MAX}
            disabled={!sections.movies.enabled}
            onChange={(max) => setSection('movies', { max })}
            onBlur={touchSections}
          />
        </SectionRow>
        <SectionRow
          label={t('newsletters.editor.sections.shows')}
          htmlFor={capId('shows')}
          enabled={sections.shows.enabled}
          onToggle={(enabled) => setSection('shows', { enabled })}
        >
          <span>{t('newsletters.editor.sections.upTo')}</span>
          <UnitInput
            id={capId('shows')}
            label={t('newsletters.editor.sections.labels.shows', { count: sections.shows.max })}
            unit={t('newsletters.editor.sections.units.shows')}
            value={sections.shows.max}
            min={1}
            max={NEWSLETTER_SECTION_MAX}
            disabled={!sections.shows.enabled}
            onChange={(max) => setSection('shows', { max })}
            onBlur={touchSections}
          />
          <span>,</span>
          <UnitInput
            id={capId('shows-seasons')}
            label={t('newsletters.editor.sections.labels.seasons', {
              count: sections.shows.maxSeasonsPerShow,
            })}
            unit={t('newsletters.editor.sections.units.seasonsEach')}
            value={sections.shows.maxSeasonsPerShow}
            min={1}
            max={NEWSLETTER_SEASONS_PER_SHOW_MAX}
            disabled={!sections.shows.enabled}
            onChange={(maxSeasonsPerShow) => setSection('shows', { maxSeasonsPerShow })}
            onBlur={touchSections}
          />
        </SectionRow>
        <SectionRow
          label={t('newsletters.editor.sections.music')}
          htmlFor={capId('music')}
          enabled={sections.music.enabled}
          onToggle={(enabled) => setSection('music', { enabled })}
          help={t('newsletters.editor.sections.musicHelp')}
        >
          <span>{t('newsletters.editor.sections.upTo')}</span>
          <UnitInput
            id={capId('music')}
            label={t('newsletters.editor.sections.labels.music', { count: sections.music.max })}
            unit={t('newsletters.editor.sections.units.albums')}
            value={sections.music.max}
            min={1}
            max={NEWSLETTER_SECTION_MAX}
            disabled={!sections.music.enabled}
            onChange={(max) => setSection('music', { max })}
            onBlur={touchSections}
          />
        </SectionRow>
        <SectionRow
          label={t('newsletters.editor.sections.mostWatched')}
          htmlFor={capId('mostWatched')}
          enabled={sections.mostWatched.enabled}
          onToggle={(enabled) => setSection('mostWatched', { enabled })}
          help={t('newsletters.editor.sections.mostWatchedHelp')}
        >
          <span>{t('newsletters.editor.sections.the')}</span>
          <UnitInput
            id={capId('mostWatched')}
            label={t('newsletters.editor.sections.labels.mostWatched', {
              count: sections.mostWatched.max,
            })}
            unit={t('newsletters.editor.sections.units.mostPlayed')}
            value={sections.mostWatched.max}
            min={1}
            max={NEWSLETTER_MOST_WATCHED_MAX}
            disabled={!sections.mostWatched.enabled}
            onChange={(max) => setSection('mostWatched', { max })}
            onBlur={touchSections}
          />
        </SectionRow>
        <FieldError>{errors.sections}</FieldError>
      </FieldSet>
    </EditorCard>
  );
}
