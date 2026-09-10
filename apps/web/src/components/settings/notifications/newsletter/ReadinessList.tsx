import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Info,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  memberFacingUrl,
  type Destination,
  type NewsletterRecipients,
  type NewsletterRecipientsView,
  type NewsletterVariantsView,
  type Server,
} from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { FieldDescription } from '@/components/ui/field';
import {
  useDestinations,
  useNewsletterRecipients,
  useNewsletterVariants,
  useServers,
  useSettings,
} from '@/hooks/queries';
import { formatList } from '@/lib/listFormat';
import { cn } from '@/lib/utils';
import type { Translate } from '../newsletterFormat';
import { EditorCard } from './EditorCard';
import {
  DELIVERY_CARD_ID,
  NEWSLETTER_FIELD_IDS,
  RECIPIENTS_CARD_ID,
  recipientsQueryId,
  scopeMoved,
  scopedServers,
  type NewsletterFormState,
} from './newsletterForm';
import { extraRecipients, partitionRecipients } from './RecipientsPanel';

export const DNS_DOCS_URL = 'https://docs.tracearr.com/configuration/email#spf-dkim-and-dmarc';

export const SERVER_SETTINGS_PATH = '/settings/servers/connections';

export const REMOTE_ACCESS_PATH = '/settings/access/remote';

export type PrivateServerReason = 'noPublicUrl' | 'privatePublicUrl';

export type ReadinessStatus = 'pass' | 'warn' | 'fail' | 'error' | 'unknown' | 'info';

/** Narrowing per id keeps every `t()` key below a literal one: externalUrl has no unknown state, destination has no warn. */
export type ReadinessCheck =
  | { id: 'destination'; status: 'pass' | 'fail' | 'error' | 'unknown'; name: string | null }
  | { id: 'externalUrl'; status: 'pass' | 'warn' | 'fail' }
  | { id: 'fromDomain'; status: 'pass' | 'fail' | 'unknown' }
  | { id: 'recipients'; status: 'pass' | 'fail' | 'unknown'; count: number }
  | { id: 'privateServer'; status: 'warn'; server: string; reason: PrivateServerReason }
  | { id: 'emptyVariant'; status: 'warn'; servers: string[] }
  | { id: 'variantsLoadFailed'; status: 'unknown' }
  | { id: 'dns'; status: 'info' };

const SEVERITY: Record<ReadinessStatus, number> = {
  fail: 0,
  error: 0,
  warn: 1,
  unknown: 2,
  pass: 3,
  info: 4,
};

const scrollToCard = (id: string) =>
  document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });

const domainOf = (address: string | null | undefined): string | null => {
  if (!address || !address.includes('@')) return null;
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
};

/** Members off is always known client-side; members on is known once the saved view resolves. */
export function recipientsState(
  form: NewsletterRecipients,
  view: NewsletterRecipientsView | undefined
): { resolvable: number; known: boolean } {
  if (!form.members)
    return { resolvable: extraRecipients(form.extraAddresses).length, known: true };
  if (!view) return { resolvable: 0, known: false };
  const { receive, included } = partitionRecipients(view, form.excludeUserIds);
  return { resolvable: receive.length + included.length, known: true };
}

export function readinessChecks(input: {
  externalUrl: string | null;
  destinationId: string | null;
  destination: Destination | null;
  destinationsError: boolean;
  recipients: { form: NewsletterRecipients; view: NewsletterRecipientsView | undefined };
  servers: Pick<Server, 'name' | 'type' | 'url' | 'publicUrl'>[];
  variants: NewsletterVariantsView | undefined;
  variantsError: boolean;
}): ReadinessCheck[] {
  const from = domainOf(input.destination?.config?.['fromAddress']);
  const user = domainOf(input.destination?.config?.['username']);
  const recipients = recipientsState(input.recipients.form, input.recipients.view);
  const privateServers: ReadinessCheck[] = input.servers
    .filter((s) => s.type !== 'plex' && memberFacingUrl(s) === null)
    .map((s) => ({
      id: 'privateServer',
      status: 'warn',
      server: s.name,
      reason: s.publicUrl ? 'privatePublicUrl' : 'noPublicUrl',
    }));
  const emptyVariants: ReadinessCheck[] =
    input.variants && input.variants.variants.length > 1
      ? input.variants.variants
          .filter((v) => v.isEmpty)
          .map((v) => ({ id: 'emptyVariant', status: 'warn', servers: v.serverNames }))
      : [];
  const variantsLoadFailed: ReadinessCheck[] = input.variantsError
    ? [{ id: 'variantsLoadFailed', status: 'unknown' }]
    : [];
  const checks: ReadinessCheck[] = [
    {
      id: 'destination',
      status: !input.destinationId
        ? 'fail'
        : input.destination
          ? 'pass'
          : input.destinationsError
            ? 'error'
            : 'unknown',
      name: input.destination?.name ?? null,
    },
    {
      id: 'externalUrl',
      status: !input.externalUrl
        ? 'fail'
        : /^https:\/\//i.test(input.externalUrl)
          ? 'pass'
          : 'warn',
    },
    // A username without an @ is an API key or a plain login; nothing to compare.
    {
      id: 'fromDomain',
      status: !input.destination ? 'unknown' : user === null || user === from ? 'pass' : 'fail',
    },
    {
      id: 'recipients',
      status: !recipients.known ? 'unknown' : recipients.resolvable > 0 ? 'pass' : 'fail',
      count: recipients.resolvable,
    },
    ...privateServers,
    ...emptyVariants,
    ...variantsLoadFailed,
    { id: 'dns', status: 'info' },
  ];
  // Array.prototype.sort is stable, so rows of one severity keep the order above.
  return checks.sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status]);
}

const ICONS: Record<ReadinessStatus, LucideIcon> = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
  error: XCircle,
  unknown: HelpCircle,
  info: Info,
};
const TONES: Record<ReadinessStatus, string> = {
  pass: 'text-success',
  warn: 'text-warning',
  fail: 'text-destructive',
  error: 'text-destructive',
  unknown: 'text-muted-foreground',
  info: 'text-muted-foreground',
};

export function ReadinessList({
  state,
  newsletterId,
  savedServerIds,
}: {
  state: NewsletterFormState;
  newsletterId: string | null;
  /** The saved row's `scope.serverIds`, or null before the first save; the recipient rows read the saved row. */
  savedServerIds: string[] | null;
}) {
  const { t, i18n } = useTranslation('settings');
  const translate = t as Translate;
  const { data: settings } = useSettings();
  const { data: destinations, isError: destinationsError } = useDestinations();
  const { data: servers } = useServers();
  const { data: view, isError: recipientsError } = useNewsletterRecipients(
    recipientsQueryId(state.recipients, newsletterId)
  );
  const { data: variants, isError: variantsError } = useNewsletterVariants(
    newsletterId ?? undefined
  );
  const destination = (destinations ?? []).find((d) => d.id === state.destinationId) ?? null;
  const inScope = scopedServers(state.scope, servers ?? []);
  const checks = readinessChecks({
    externalUrl: settings?.externalUrl ?? null,
    destinationId: state.destinationId,
    destination,
    destinationsError,
    recipients: { form: state.recipients, view },
    servers: inScope,
    variants,
    variantsError,
  });
  const staleScope = scopeMoved(savedServerIds, state.scope.serverIds);

  const copyFor = (check: ReadinessCheck): ReactNode => {
    switch (check.id) {
      case 'destination':
        if (check.status === 'pass')
          return t('newsletters.editor.readiness.destination', { name: check.name ?? '' });
        if (check.status === 'unknown') return t('newsletters.editor.readiness.destinationUnknown');
        if (check.status === 'error') return t('newsletters.editor.readiness.destinationError');
        return t('newsletters.editor.readiness.destinationFail');
      case 'externalUrl':
        if (check.status === 'pass') return t('newsletters.editor.readiness.externalUrl');
        if (check.status === 'warn') return t('newsletters.editor.readiness.externalUrlNotHttps');
        return t('newsletters.editor.readiness.externalUrlFail');
      case 'fromDomain':
        if (check.status === 'pass') return t('newsletters.editor.readiness.fromDomain');
        if (check.status === 'unknown') return t('newsletters.editor.readiness.fromDomainUnknown');
        return t('newsletters.editor.readiness.fromDomainFail');
      case 'recipients':
        if (check.status === 'pass')
          return translate('newsletters.editor.readiness.recipients', { count: check.count });
        if (check.status === 'fail') return t('newsletters.editor.readiness.recipientsFail');
        // A saved newsletter whose recipients failed to load says so; an unsaved one has nothing to query yet, so it says recipients are unknown until save.
        return newsletterId !== null && recipientsError
          ? t('newsletters.editor.readiness.recipientsLoadFailed')
          : t('newsletters.editor.readiness.recipientsUnknown');
      case 'privateServer': {
        const link = (
          <Link to={SERVER_SETTINGS_PATH} className="underline underline-offset-4">
            {t('newsletters.editor.readiness.serverSettingsLink')}
          </Link>
        );
        if (check.reason === 'noPublicUrl') {
          return (
            <>
              {t('newsletters.editor.readiness.noPublicUrl', { server: check.server })} {link}
            </>
          );
        }
        return (
          <>
            {t('newsletters.editor.readiness.privatePublicUrl', { server: check.server })} {link}
          </>
        );
      }
      case 'emptyVariant':
        return t('newsletters.editor.readiness.emptyVariant', {
          servers: formatList(i18n.language, check.servers),
        });
      case 'variantsLoadFailed':
        return t('newsletters.editor.readiness.variantsLoadFailed');
      case 'dns':
        return (
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
        );
    }
  };

  /** A failing row ends with the way to the control it is about. */
  const actionFor = (check: ReadinessCheck): ReactNode => {
    if (check.status !== 'fail') return null;
    switch (check.id) {
      case 'destination':
        return (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => {
              const select = document.getElementById(NEWSLETTER_FIELD_IDS.destination);
              if (select) select.focus();
              else scrollToCard(DELIVERY_CARD_ID);
            }}
          >
            {t('newsletters.editor.readiness.fixDestination')}
          </Button>
        );
      case 'recipients':
        return (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => scrollToCard(RECIPIENTS_CARD_ID)}
          >
            {t('newsletters.editor.readiness.fixRecipients')}
          </Button>
        );
      case 'externalUrl':
        return (
          <Link to={REMOTE_ACCESS_PATH} className="underline underline-offset-4">
            {t('newsletters.editor.readiness.fixExternalUrl')}
          </Link>
        );
      default:
        return null;
    }
  };

  return (
    <EditorCard
      title={t('newsletters.editor.readiness.title')}
      description={t('newsletters.editor.readiness.intro')}
    >
      {staleScope && (
        <FieldDescription>{t('newsletters.editor.readiness.staleScope')}</FieldDescription>
      )}
      <ul className="flex flex-col gap-2">
        {checks.map((check) => {
          const Icon = ICONS[check.status];
          const action = actionFor(check);
          return (
            <li
              key={
                check.id === 'privateServer'
                  ? `privateServer-${check.server}`
                  : check.id === 'emptyVariant'
                    ? `emptyVariant-${check.servers.join(',')}`
                    : check.id
              }
              className="flex items-start gap-2 text-sm leading-snug"
            >
              <Icon
                aria-hidden
                className={cn('mt-0.5 size-[0.9375rem] shrink-0', TONES[check.status])}
              />
              <span>
                {copyFor(check)}
                {action && <> {action}</>}
              </span>
            </li>
          );
        })}
      </ul>
    </EditorCard>
  );
}
