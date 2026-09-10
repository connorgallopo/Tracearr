import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Send, TestTube2 } from 'lucide-react';
import type { Newsletter, NewsletterPreview } from '@tracearr/shared';
import { z } from 'zod';
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
import { HtmlPreviewDialog } from '@/components/settings/shared/HtmlPreviewDialog';
import { usePreviewNewsletter, useTestNewsletter } from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
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
  const [testOpen, setTestOpen] = useState(false);
  const [testAddress, setTestAddress] = useState(user?.email ?? '');
  const [sending, setSending] = useState(false);

  const label = (action: 'preview' | 'test' | 'send') =>
    dirty
      ? translate(`newsletters.editor.actions.saveAnd${action[0]?.toUpperCase()}${action.slice(1)}`)
      : translate(`newsletters.editor.actions.${action}`);

  const openPreview = () => {
    setPreviewed(null);
    setPreviewOpen(true);
    preview.mutate(newsletter.id, {
      onSuccess: setPreviewed,
      onError: () => setPreviewOpen(false),
    });
  };

  const openTest = () => {
    setTestAddress(user?.email ?? '');
    setTestOpen(true);
  };

  const meta = previewed && (
    <div className="text-muted-foreground flex flex-col gap-1 text-sm">
      <span>
        {t('newsletters.editor.preview.window', {
          start: windowLabel(previewed.window.start, i18n.language, newsletter.timezone),
          end: windowLabel(previewed.window.end, i18n.language, newsletter.timezone),
        })}
      </span>
      <span>{countsLine(previewed.variants[0].counts, translate)}</span>
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
        subject={previewed?.variants[0].subject}
        meta={meta}
        html={previewed?.variants[0].html ?? null}
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              disabled={test.isPending || !address.safeParse(testAddress.trim()).success}
              onClick={() =>
                test.mutate(
                  { id: newsletter.id, address: testAddress.trim() },
                  { onSuccess: () => setTestOpen(false) }
                )
              }
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
