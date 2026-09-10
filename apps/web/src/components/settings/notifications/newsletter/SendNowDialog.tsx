import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NewsletterPreview } from '@tracearr/shared';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { usePreviewNewsletter, useSendNewsletter } from '@/hooks/queries';
import type { Translate } from '../newsletterFormat';
import { sendSummary } from './previewSummary';

interface SendNowDialogProps {
  /** Open while set; the preview runs for it as soon as it is. */
  newsletterId: string | null;
  name: string;
  timezone: string;
  onOpenChange: (open: boolean) => void;
}

export function SendNowDialog({ newsletterId, name, timezone, onOpenChange }: SendNowDialogProps) {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const preview = usePreviewNewsletter();
  const send = useSendNewsletter();
  const [summary, setSummary] = useState<NewsletterPreview | null>(null);

  useEffect(() => {
    setSummary(null);
    if (!newsletterId) return;
    preview.mutate(newsletterId, {
      onSuccess: setSummary,
      // The hook's own onError already toasts the failure; here we just close a dialog that can't proceed.
      onError: () => onOpenChange(false),
    });
    // The mutation object is a new reference each render; only the id decides when to preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newsletterId]);

  if (!newsletterId) return null;
  const nobody = summary !== null && summary.recipients.resolved === 0;
  const description = summary
    ? nobody
      ? t('newsletters.editor.send.nobody', { missing: summary.recipients.missingEmail })
      : sendSummary(summary, t as Translate, i18n.language, timezone)
    : t('newsletters.editor.send.previewing');
  const confirmLabel = t('newsletters.editor.send.confirm');

  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title={t('newsletters.editor.send.title', { name })}
      description={description}
      confirmLabel={confirmLabel}
      // Only an actual send relabels the button; "previewing" and "nobody resolves" just disable it.
      confirmLoadingLabel={send.isPending ? t('newsletters.editor.send.sending') : confirmLabel}
      cancelLabel={t('common:actions.cancel')}
      variant="default"
      isLoading={send.isPending || summary === null || nobody}
      onConfirm={() => send.mutate(newsletterId, { onSettled: () => onOpenChange(false) })}
    />
  );
}
