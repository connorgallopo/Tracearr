import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Send, TestTube2 } from 'lucide-react';
import type { Newsletter, NewsletterPreview } from '@tracearr/shared';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { HtmlPreviewDialog } from '@/components/settings/shared/HtmlPreviewDialog';
import { usePreviewNewsletter, useNewsletterVariants, useTestNewsletter } from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { formatList } from '@/lib/listFormat';
import { countsLine, type Translate } from '../newsletterFormat';
import { SendNowDialog } from './SendNowDialog';
import { windowLabel } from './previewSummary';
import type { SaveThen } from './useNewsletterSave';

const address = z.email();

interface NewsletterActionsProps {
  newsletter: Newsletter;
  dirty: boolean;
  saveThen: SaveThen;
}

interface SwitchableVariant {
  key: string;
  serverNames: string[];
  recipientCount: number;
}

/** One toggle per variant, the recipient count as a badge; rendered only when there is something to switch between. */
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
            aria-label={t('newsletters.editor.previewVariant', { servers })}
          >
            {servers}
            <Badge variant="secondary">{variant.recipientCount}</Badge>
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

/** Preview, Send test and Send now act on the saved row; a dirty form saves first, in the same click. */
export function NewsletterActions({ newsletter, dirty, saveThen }: NewsletterActionsProps) {
  const { t, i18n } = useTranslation(['settings', 'common']);
  // i18next's TFunction can't verify a key built from the action name at compile time.
  const translate = t as Translate;
  const { user } = useAuth();
  const preview = usePreviewNewsletter();
  const test = useTestNewsletter();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewed, setPreviewed] = useState<NewsletterPreview | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [testAddress, setTestAddress] = useState(user?.email ?? '');
  const [testKey, setTestKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const variantsQuery = useNewsletterVariants(testOpen ? newsletter.id : undefined);

  const label = (action: 'preview' | 'test' | 'send') =>
    dirty
      ? translate(`newsletters.editor.actions.saveAnd${action[0]?.toUpperCase()}${action.slice(1)}`)
      : translate(`newsletters.editor.actions.${action}`);

  const openPreview = () => {
    setPreviewed(null);
    setPreviewKey(null);
    setPreviewOpen(true);
    preview.mutate(newsletter.id, {
      onSuccess: setPreviewed,
      onError: () => setPreviewOpen(false),
    });
  };

  const openTest = () => {
    setTestAddress(user?.email ?? '');
    setTestKey(null);
    setTestOpen(true);
  };

  const shown =
    previewed?.variants.find((variant) => variant.key === previewKey) ?? previewed?.variants[0];

  const meta = previewed && shown && (
    <div className="text-muted-foreground flex flex-col gap-2 text-sm">
      <VariantSwitcher
        variants={previewed.variants}
        value={shown.key}
        onChange={setPreviewKey}
        label={t('newsletters.editor.preview.variants')}
      />
      <span>
        {t('newsletters.editor.preview.window', {
          start: windowLabel(previewed.window.start, i18n.language, newsletter.timezone),
          end: windowLabel(previewed.window.end, i18n.language, newsletter.timezone),
        })}
      </span>
      <span>{countsLine(shown.counts, translate)}</span>
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
    <>
      <Button variant="outline" onClick={() => saveThen(openPreview)}>
        <Eye />
        {label('preview')}
      </Button>
      <Button variant="outline" onClick={() => saveThen(openTest)}>
        <TestTube2 />
        {label('test')}
      </Button>
      <Button onClick={() => saveThen(() => setSending(true))}>
        <Send />
        {label('send')}
      </Button>

      <HtmlPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        title={t('newsletters.editor.preview.title')}
        subject={shown?.subject}
        meta={meta}
        html={shown?.html ?? null}
        loading={previewed === null}
      />

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
  );
}
