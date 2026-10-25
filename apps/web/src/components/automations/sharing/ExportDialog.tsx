import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { TEMPLATE_GROUPS, type Automation } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  TemplateSentencePanel,
  useTemplateBinding,
} from '@/components/automations/gallery/TemplateInputs';
import { useExportAutomation } from '@/hooks/queries/useAutomations';
import { useImportTemplate } from '@/hooks/queries/useTemplates';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { cn } from '@/lib/utils';
import { Disclosure } from './Disclosure';
import { GALLERY_URL, LinkOut, REPOSITORY_URL } from './links';
import type { TemplateGroup } from '@/lib/api';

/** Long enough that a name is finished before the code is rebuilt around it. */
const AUTHOR_SETTLE_MS = 400;

interface ExportDialogProps {
  automation: Pick<Automation, 'id' | 'name'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** One code to send, the envelope behind it, and the option to keep a copy. Mounted only while open. */
export function ExportDialog({ automation, open, onOpenChange }: ExportDialogProps) {
  const { t } = useTranslation(['pages', 'common']);
  const [author, setAuthor] = useState('');
  // Unset until the reader picks one, which is when the server stops choosing by kind.
  const [group, setGroup] = useState<TemplateGroup | undefined>(undefined);

  const settled = useDebouncedValue(author.trim(), AUTHOR_SETTLE_MS);
  const { data, isError, isPlaceholderData } = useExportAutomation(automation.id, settled, group);
  const save = useImportTemplate();

  const envelope = data?.envelope;
  const { fragments } = useTemplateBinding(envelope, {});

  const saveAsTemplate = () => {
    if (!envelope) return;
    save.mutate(
      { envelope, source: 'local' },
      {
        onSuccess: () =>
          toast.success(t('pages:automations.export.saved', { name: envelope.name })),
        onError: (error: Error) =>
          toast.error(t('pages:automations.export.saveFailed'), { description: error.message }),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The footer button is the way out; a second one named Close is a second way to say it. */}
      <DialogContent showCloseButton={false} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('pages:automations.export.title')}</DialogTitle>
          <DialogDescription>{t('pages:automations.export.description')}</DialogDescription>
        </DialogHeader>

        {isError ? (
          <p className="text-muted-foreground text-sm">{t('pages:automations.export.failed')}</p>
        ) : !data ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-20" />
            <Skeleton className="h-24" />
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <TemplateSentencePanel fragments={fragments} />

            <div className="flex flex-col gap-2">
              <CodeBlock
                value={data.code}
                copyLabel={t('pages:automations.export.copyCode')}
                disabled={isPlaceholderData}
                className="font-mono break-all whitespace-pre-wrap"
              />
              <p className="text-muted-foreground text-xs leading-relaxed">
                {t('pages:automations.export.carries')}
              </p>
              {settled !== '' && (
                <p className="text-muted-foreground text-xs">
                  {t('pages:automations.export.authorInCode')}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <Disclosure label={t('pages:automations.export.gallery.trigger')}>
                <div className="flex flex-col gap-4">
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    {t('pages:automations.export.gallery.body')}
                  </p>

                  <Field>
                    <FieldLabel htmlFor="export-author">
                      {t('pages:automations.export.authorLabel')}
                    </FieldLabel>
                    <Input
                      id="export-author"
                      value={author}
                      maxLength={80}
                      placeholder={t('pages:automations.export.authorPlaceholder')}
                      onChange={(event) => setAuthor(event.target.value)}
                    />
                    <FieldDescription>
                      {t('pages:automations.export.authorHelper')}
                    </FieldDescription>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="export-group">
                      {t('pages:automations.export.groupLabel')}
                    </FieldLabel>
                    <Select
                      value={group ?? data.envelope.group}
                      onValueChange={(value) => setGroup(value as TemplateGroup)}
                    >
                      <SelectTrigger id="export-group">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TEMPLATE_GROUPS.map((entry) => (
                          <SelectItem key={entry} value={entry}>
                            {t(`pages:automations.gallery.group.${entry}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldDescription>{t('pages:automations.export.groupHelper')}</FieldDescription>
                  </Field>

                  <CodeBlock
                    value={JSON.stringify(data.envelope, null, 2)}
                    copyLabel={t('pages:automations.export.copyJson')}
                    disabled={isPlaceholderData}
                  />

                  <div className="flex flex-wrap items-center gap-1">
                    <LinkOut href={GALLERY_URL} label={t('pages:automations.openGallery')} />
                    <LinkOut
                      href={REPOSITORY_URL}
                      label={t('pages:automations.export.openRepository')}
                    />
                  </div>
                </div>
              </Disclosure>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2"
                  onClick={saveAsTemplate}
                  disabled={save.isPending || isPlaceholderData}
                >
                  {t('pages:automations.export.save')}
                </Button>
                <span className="text-muted-foreground text-xs">
                  {t('pages:automations.export.saveHelper')}
                </span>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t('common:actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A block to copy, with the button beside it rather than floating over it. */
function CodeBlock({
  value,
  copyLabel,
  disabled,
  className,
}: {
  value: string;
  copyLabel: string;
  disabled: boolean;
  className?: string;
}) {
  const pre = useRef<HTMLPreElement>(null);
  return (
    <div className="flex items-start gap-2">
      <pre
        ref={pre}
        className={cn(
          'bg-muted/40 max-h-40 flex-1 overflow-auto rounded-md p-3 text-xs',
          className
        )}
      >
        {value}
      </pre>
      <CopyButton
        value={value}
        label={copyLabel}
        showLabel
        disabled={disabled}
        selectTarget={() => pre.current}
      />
    </div>
  );
}
