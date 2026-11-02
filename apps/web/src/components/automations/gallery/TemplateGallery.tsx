import { useMemo, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardPaste, PencilLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Kbd } from '@/components/ui/kbd';
import { Skeleton } from '@/components/ui/skeleton';
import { useSettings } from '@/hooks/queries/useSettings';
import {
  describeTemplate,
  templateKeywords,
  templateName,
  type DescribeRefs,
} from '@/lib/automations';
import { compareText } from '@/lib/collation';
import type { AutomationTemplate, TemplateGroup } from '@/lib/api';
import { GalleryRow, TemplateCard } from './TemplateCard';

/** Ascending consequence: the ones that only tell you things first, the ones that act last. */
const GROUP_ORDER = [
  'notifications',
  'server_health',
  'policies',
  'housekeeping',
] as const satisfies readonly TemplateGroup[];

const NO_REFS: DescribeRefs = {};

const ROW_CLASSES = 'p-0 data-[selected=true]:bg-transparent';

interface TemplateGalleryProps {
  templates: readonly AutomationTemplate[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** Held by the dialog so `/` can put the cursor back in the box from anywhere. */
  searchRef: RefObject<HTMLInputElement | null>;
  onPick: (id: string) => void;
  onPaste: () => void;
  onScratch: () => void;
}

/** The catalog in one scroll: four groups, then the two other ways in. */
export function TemplateGallery({
  templates,
  isLoading,
  isError,
  onRetry,
  searchRef,
  onPick,
  onPaste,
  onScratch,
}: TemplateGalleryProps) {
  const { t } = useTranslation('pages');
  const { data: settings } = useSettings();
  const [query, setQuery] = useState('');
  const unitSystem = settings?.unitSystem ?? 'metric';

  // cmdk matches on the item's value, so the name, the sentence and the synonyms
  // all have to be in it; the card renders the parts a reader is meant to read.
  const entries = useMemo(
    () =>
      templates.map((template) => {
        // Uncapped: the whole sentence is worth searching, however long it runs.
        const sentence = describeTemplate(template.version, {}, NO_REFS, t, unitSystem)
          .map((fragment) => fragment.text)
          .join(' ');
        const name = templateName(t, template);
        return {
          template,
          haystack: `${name} ${sentence} ${templateKeywords(t, template.slug)}`,
        };
      }),
    [templates, t, unitSystem]
  );

  const doors = (
    <CommandGroup forceMount heading={t('automations.gallery.group.other')}>
      <CommandItem
        forceMount
        value="paste share code import"
        className={`group ${ROW_CLASSES}`}
        onSelect={onPaste}
      >
        <GalleryRow
          dashed
          icon={<ClipboardPaste />}
          title={t('automations.gallery.paste.title')}
          description={t('automations.gallery.paste.description')}
        />
      </CommandItem>
      <CommandItem
        forceMount
        value="start from scratch build your own"
        className={`group ${ROW_CLASSES}`}
        onSelect={onScratch}
      >
        <GalleryRow
          dashed
          icon={<PencilLine />}
          title={t('automations.gallery.scratch.title')}
          description={t('automations.gallery.scratch.description')}
        />
      </CommandItem>
    </CommandGroup>
  );

  return (
    <Command className="flex min-h-0 flex-1 flex-col bg-transparent">
      <CommandInput
        ref={searchRef}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the gallery opens to search
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder={t('automations.gallery.searchPlaceholder')}
      />

      {isError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-muted-foreground text-sm">{t('automations.gallery.failed')}</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {t('automations.gallery.retry')}
          </Button>
        </div>
      ) : isLoading ? (
        <div className="flex-1 space-y-4 overflow-hidden px-3 py-3" aria-busy>
          <span className="sr-only">{t('automations.gallery.loading')}</span>
          {GROUP_ORDER.map((group) => (
            <div key={group} className="space-y-1.5">
              <p className="text-muted-foreground px-2 text-xs font-medium">
                {t(`automations.gallery.group.${group}`)}
              </p>
              {[0, 1, 2].map((row) => (
                <Skeleton key={row} className="h-14 w-full" />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <CommandList className="max-h-none flex-1 px-2 pb-2">
          <CommandEmpty>
            <p>{t('automations.gallery.noMatches', { query })}</p>
            <p className="text-muted-foreground mt-1 text-[0.8125rem]">
              {t('automations.gallery.noMatchesHint')}
            </p>
          </CommandEmpty>

          {GROUP_ORDER.map((group) => (
            <CommandGroup key={group} heading={t(`automations.gallery.group.${group}`)}>
              {entries
                .filter((entry) => entry.template.group === group)
                .sort((a, b) =>
                  compareText(templateName(t, a.template), templateName(t, b.template))
                )
                .map(({ template, haystack }) => (
                  <CommandItem
                    key={template.id}
                    value={haystack}
                    className={`group ${ROW_CLASSES}`}
                    onSelect={() => onPick(template.id)}
                  >
                    <TemplateCard template={template} />
                  </CommandItem>
                ))}
            </CommandGroup>
          ))}

          {doors}
        </CommandList>
      )}

      <div className="text-muted-foreground flex items-center gap-4 border-t px-4 py-2 text-xs max-sm:hidden">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          {t('automations.gallery.hint.move')}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd>
          {t('automations.gallery.hint.use')}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>esc</Kbd>
          {t('automations.gallery.hint.close')}
        </span>
      </div>
    </Command>
  );
}
