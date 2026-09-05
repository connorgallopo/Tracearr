import { useTranslation } from 'react-i18next';
import { CheckCircle2, HelpCircle, Info, XCircle, type LucideIcon } from 'lucide-react';
import type { Destination } from '@tracearr/shared';
import { FieldLegend, FieldSet } from '@/components/ui/field';
import { useDestinations, useNewsletterRecipients, useSettings } from '@/hooks/queries';
import { cn } from '@/lib/utils';
import type { NewsletterFormState } from './newsletterForm';

export const DNS_DOCS_URL = 'https://docs.tracearr.com/configuration/email#spf-dkim-and-dmarc';

export type ReadinessStatus = 'pass' | 'fail' | 'unknown' | 'info';
export interface ReadinessCheck {
  id: 'externalUrl' | 'fromDomain' | 'recipients' | 'dns';
  status: ReadinessStatus;
}

const domainOf = (address: string | null | undefined): string | null => {
  if (!address || !address.includes('@')) return null;
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
};

export function readinessChecks(input: {
  externalUrl: string | null;
  destination: Destination | null;
  recipients: { resolvable: number; known: boolean };
}): ReadinessCheck[] {
  const from = domainOf(input.destination?.config?.['fromAddress']);
  const user = domainOf(input.destination?.config?.['username']);
  return [
    { id: 'externalUrl', status: input.externalUrl ? 'pass' : 'fail' },
    // A username without an @ is an API key or a plain login; nothing to compare.
    {
      id: 'fromDomain',
      status: !input.destination ? 'unknown' : user === null || user === from ? 'pass' : 'fail',
    },
    {
      id: 'recipients',
      status: !input.recipients.known
        ? 'unknown'
        : input.recipients.resolvable > 0
          ? 'pass'
          : 'fail',
    },
    { id: 'dns', status: 'info' },
  ];
}

const ICONS: Record<ReadinessStatus, LucideIcon> = {
  pass: CheckCircle2,
  fail: XCircle,
  unknown: HelpCircle,
  info: Info,
};
const TONES: Record<ReadinessStatus, string> = {
  pass: 'text-success',
  fail: 'text-warning',
  unknown: 'text-muted-foreground',
  info: 'text-muted-foreground',
};

export function ReadinessList({
  state,
  newsletterId,
}: {
  state: NewsletterFormState;
  newsletterId: string | null;
}) {
  const { t } = useTranslation('settings');
  const { data: settings } = useSettings();
  const { data: destinations } = useDestinations();
  const { data: view } = useNewsletterRecipients(newsletterId ?? undefined);
  const destination = (destinations ?? []).find((d) => d.id === state.destinationId) ?? null;
  const checks = readinessChecks({
    externalUrl: settings?.externalUrl ?? null,
    destination,
    recipients: {
      known: view !== undefined,
      resolvable: view ? view.recipients.filter((r) => !r.suppressed).length : 0,
    },
  });

  return (
    <FieldSet>
      <FieldLegend>{t('newsletters.editor.readiness.title')}</FieldLegend>
      <section className="bg-muted/25 rounded-lg px-3.5 py-3">
        <ul className="flex flex-col gap-2">
          {checks.map((check) => {
            const Icon = ICONS[check.status];
            return (
              <li key={check.id} className="flex items-start gap-2 text-sm leading-snug">
                <Icon
                  aria-hidden
                  className={cn('mt-0.5 size-[0.9375rem] shrink-0', TONES[check.status])}
                />
                <span>
                  {check.id === 'dns' ? (
                    <>
                      {t('newsletters.editor.readiness.dns')}{' '}
                      <a
                        href={DNS_DOCS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-4"
                      >
                        {t('newsletters.editor.readiness.dnsLink')}
                      </a>
                    </>
                  ) : (
                    t(
                      `newsletters.editor.readiness.${check.id}${check.status === 'unknown' ? 'Unknown' : check.status === 'pass' ? '' : 'Fail'}`
                    )
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </FieldSet>
  );
}
