import { useImperativeHandle, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Eye, Send, TestTube2 } from 'lucide-react';
import type { Newsletter, NewsletterPreview } from '@tracearr/shared';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { HtmlPreviewDialog } from '@/components/settings/shared/HtmlPreviewDialog';
import {
  useNewsletterVariants,
  usePreviewDraftNewsletter,
  usePreviewNewsletter,
  useTestNewsletter,
} from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { formatList } from '@/lib/listFormat';
import type { Translate } from '../newsletterFormat';
import { SendNowDialog } from './SendNowDialog';
import type { NewsletterFormState } from './newsletterForm';
import {
  countsListedLine,
  defaultVariantKey,
  heldBack,
  previewVariants,
  windowLabel,
} from './previewSummary';

const address = z.email();

export interface NewsletterActionsHandle {
  openPreview: () => void;
}

interface NewsletterActionsProps {
  /** Null while the newsletter has not been saved: Preview alone, no send buttons. */
  newsletter: Newsletter | null;
  state: NewsletterFormState;
  dirty: boolean;
  valid: boolean;
  /** The page's own refusal: callers without a disabled state reach openPreview on an invalid form. */
  onRefuse: () => void;
  ref?: Ref<NewsletterActionsHandle>;
}

interface SwitchableVariant {
  key: string;
  serverNames: string[];
  recipientCount: number;
}

/** One toggle per variant, named by the people it reaches; rendered only when there is something to switch between. */
function VariantSwitcher({
  variants,
  value,
  onChange,
  label,
}: {
  variants: SwitchableVariant[];
  value: string;
  onChange: (key: string) => void;
  label: string;
}) {
  const { t, i18n } = useTranslation('settings');
  const translate = t as Translate;
  if (variants.length < 2) return null;
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value}
      onValueChange={(key) => key && onChange(key)}
      aria-label={label}
      className="flex-wrap"
    >
      {variants.map((variant) => {
        const servers = formatList(i18n.language, variant.serverNames);
        return (
          <ToggleGroupItem
            key={variant.key}
            value={variant.key}
            aria-label={translate('newsletters.editor.previewVariant', {
              count: variant.recipientCount,
              servers,
            })}
          >
            {t('newsletters.editor.preview.variantTab', {
              count: variant.recipientCount,
              servers,
            })}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

/** Preview renders the form as it is, saved or not; Send test and Send now act on the saved row and wait for a save while the form is dirty. */
export function NewsletterActions({
  newsletter,
  state,
  dirty,
  valid,
  onRefuse,
  ref,
}: NewsletterActionsProps) {
  const { t, i18n } = useTranslation(['settings', 'common']);
  // The two plural keys below exist as `_one`/`_other`, which the typed TFunction refuses as a base key.
  const translate = t as Translate;
  const { user } = useAuth();
  const preview = usePreviewNewsletter();
  const previewDraft = usePreviewDraftNewsletter();
  const test = useTestNewsletter();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewed, setPreviewed] = useState<NewsletterPreview | null>(null);
  const [previewIsDraft, setPreviewIsDraft] = useState(false);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [testAddress, setTestAddress] = useState(user?.email ?? '');
  const [testKey, setTestKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const variantsQuery = useNewsletterVariants(testOpen && newsletter ? newsletter.id : undefined);

  const openPreview = () => {
    if (!valid) {
      onRefuse();
      return;
    }
    setPreviewed(null);
    setPreviewKey(null);
    setPreviewOpen(true);
    const handlers = { onSuccess: setPreviewed, onError: () => setPreviewOpen(false) };
    if (newsletter && !dirty) {
      setPreviewIsDraft(false);
      preview.mutate(newsletter.id, handlers);
      return;
    }
    setPreviewIsDraft(true);
    previewDraft.mutate(
      { ...(newsletter ? { newsletterId: newsletter.id } : {}), newsletter: state },
      handlers
    );
  };
  useImperativeHandle(ref, () => ({ openPreview }));

  const openTest = () => {
    setTestAddress(user?.email ?? '');
    setTestKey(null);
    setTestOpen(true);
  };

  const visible = previewed ? previewVariants(previewed.variants) : [];
  const shown = visible.find(
    (variant) => variant.key === (previewKey ?? defaultVariantKey(visible))
  );
  const held = shown ? heldBack(shown.trimmed) : 0;

  const meta = previewed && shown && (
    <div className="text-muted-foreground flex flex-col gap-2 text-sm">
      <VariantSwitcher
        variants={visible}
        value={shown.key}
        onChange={setPreviewKey}
        label={t('newsletters.editor.preview.variants')}
      />
      <span>
        {t(
          previewed.window.fromWatermark
            ? 'newsletters.editor.preview.windowSince'
            : 'newsletters.editor.preview.window',
          {
            start: windowLabel(previewed.window.start, i18n.language, state.timezone),
            end: windowLabel(previewed.window.end, i18n.language, state.timezone),
          }
        )}
      </span>
      <span>{countsListedLine(shown, state.sections, translate)}</span>
      {held > 0 && <span>{translate('newsletters.editor.send.trimmed', { count: held })}</span>}
      <span>
        {t('newsletters.editor.preview.recipients', {
          resolved: previewed.recipients.resolved,
          missing: previewed.recipients.missingEmail,
          suppressed: previewed.recipients.suppressed,
        })}
      </span>
    </div>
  );

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              variant="outline"
              onClick={openPreview}
              disabled={!valid || preview.isPending || previewDraft.isPending}
            >
              <Eye />
              {t('newsletters.editor.actions.preview')}
            </Button>
          </span>
        </TooltipTrigger>
        {!valid && <TooltipContent>{t('newsletters.editor.fixFirst')}</TooltipContent>}
      </Tooltip>

      {newsletter && (
        <ButtonGroup>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="outline"
                  className="rounded-r-none"
                  onClick={openTest}
                  disabled={dirty}
                >
                  <TestTube2 />
                  {t('newsletters.editor.actions.test')}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {dirty
                ? t('newsletters.editor.sendNeedsSave')
                : t('newsletters.editor.actions.testHint')}
            </TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                aria-label={t('newsletters.editor.actions.more')}
              >
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={dirty}
                onSelect={() => setSending(true)}
                className="flex-col items-start gap-0.5"
              >
                <span className="flex items-center gap-2">
                  <Send />
                  {t('newsletters.editor.actions.send')}
                </span>
                <span className="text-muted-foreground text-xs">
                  {dirty
                    ? t('newsletters.editor.sendNeedsSave')
                    : t('newsletters.editor.actions.sendHint')}
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      )}

      <HtmlPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        title={t('newsletters.editor.preview.title')}
        subject={shown?.subject}
        meta={meta}
        notice={t('newsletters.editor.preview.linksNote')}
        html={shown?.html ?? null}
        loading={previewed === null}
        draft={previewIsDraft}
      />

      {newsletter && (
        <>
          <Dialog open={testOpen} onOpenChange={setTestOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>{t('newsletters.editor.test.title')}</DialogTitle>
                <DialogDescription>{t('newsletters.editor.test.description')}</DialogDescription>
              </DialogHeader>
              <Field>
                <FieldLabel htmlFor="newsletter-test-address">
                  {t('newsletters.editor.test.address')}
                </FieldLabel>
                <Input
                  id="newsletter-test-address"
                  type="email"
                  value={testAddress}
                  onChange={(event) => setTestAddress(event.target.value)}
                />
              </Field>
              {variantsQuery.data && variantsQuery.data.variants.length > 1 && (
                <Field>
                  <FieldLabel>{t('newsletters.editor.test.variant')}</FieldLabel>
                  <VariantSwitcher
                    variants={variantsQuery.data.variants}
                    value={testKey ?? variantsQuery.data.variants[0]?.key ?? ''}
                    onChange={setTestKey}
                    label={t('newsletters.editor.test.variant')}
                  />
                </Field>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setTestOpen(false)}>
                  {t('common:actions.cancel')}
                </Button>
                <Button
                  disabled={test.isPending || !address.safeParse(testAddress.trim()).success}
                  onClick={() => {
                    const union = variantsQuery.data?.variants[0]?.key;
                    test.mutate(
                      {
                        id: newsletter.id,
                        address: testAddress.trim(),
                        ...(testKey && testKey !== union ? { variantKey: testKey } : {}),
                      },
                      { onSuccess: () => setTestOpen(false) }
                    );
                  }}
                >
                  {t('newsletters.editor.test.send')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <SendNowDialog
            newsletterId={sending ? newsletter.id : null}
            name={newsletter.name}
            timezone={newsletter.timezone}
            onOpenChange={(open) => setSending(open)}
          />
        </>
      )}
    </TooltipProvider>
  );
}
