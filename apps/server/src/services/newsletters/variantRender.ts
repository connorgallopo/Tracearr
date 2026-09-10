import type { PosterRef } from '../../db/schema.js';
import type { ResolvedEmailBranding } from '../notifications/emailBranding.js';
import { readLogoPng } from '../notifications/emailLogo.js';
import { renderTemplate } from '../notifications/types.js';
import { assembleDigest, groupDigest, type DigestData } from './assemble.js';
import { renderDigestToFit, type FitResult } from './fit.js';
import {
  UNSUBSCRIBE_PLACEHOLDER,
  VIEW_PLACEHOLDER,
  formatWindowDate,
  logoRefFor,
  resolveImageMode,
} from './render.js';
import type { NewsletterRow, ServerLink } from './store.js';
import { variantScope, variantSenderName, type PlannedVariant } from './variants.js';

export interface VariantRenderContext {
  newsletter: Pick<
    NewsletterRow,
    | 'id'
    | 'scope'
    | 'sections'
    | 'subject'
    | 'senderName'
    | 'intro'
    | 'outro'
    | 'timezone'
    | 'imageMode'
    | 'links'
  >;
  window: { start: Date; end: Date };
  externalUrl: string | null;
  branding: ResolvedEmailBranding;
  /** The newsletter's servers in its own order. */
  servers: ServerLink[];
  memberSend: boolean;
}

export async function assembleVariant(
  ctx: Pick<VariantRenderContext, 'newsletter' | 'window'>,
  variant: Pick<PlannedVariant, 'serverIds'>,
  opts: { posters?: boolean } = {}
): Promise<{ data: DigestData; posters: Record<string, PosterRef> }> {
  const scope = variantScope(ctx.newsletter.scope, variant.serverIds);
  if (scope === null) return { data: groupDigest([], ctx.newsletter.sections), posters: {} };
  return assembleDigest({ scope, sections: ctx.newsletter.sections }, ctx.window, opts);
}

export interface RenderedVariant {
  subject: string;
  senderName: string;
  fit: FitResult;
}

/** The one render entry for a send, a test and the preview: the subject and the fitted digest for one variant. */
export async function renderVariant(
  ctx: VariantRenderContext,
  variant: Pick<PlannedVariant, 'serverIds' | 'serverNames'>,
  data: DigestData,
  posters: Record<string, PosterRef>
): Promise<RenderedVariant> {
  const { newsletter, window, externalUrl } = ctx;
  const senderName = variantSenderName(newsletter, variant.serverNames);
  const mode = resolveImageMode(newsletter.imageMode, externalUrl);
  const origin = externalUrl?.replace(/\/$/, '') ?? '';
  const subject = renderTemplate(newsletter.subject, {
    server_name: senderName,
    start_date: formatWindowDate(window.start, newsletter.timezone),
    end_date: formatWindowDate(window.end, newsletter.timezone),
    item_count: String(data.counts.movies + data.counts.episodes + data.counts.albums),
  });
  const serversById = new Map(
    ctx.servers.filter((s) => variant.serverIds.includes(s.id)).map((s) => [s.id, s])
  );
  const fit = await renderDigestToFit(
    data,
    posters,
    {
      subject,
      intro: newsletter.intro,
      outro: newsletter.outro,
      windowStart: formatWindowDate(window.start, newsletter.timezone),
      windowEnd: formatWindowDate(window.end, newsletter.timezone),
      logoRef: logoRefFor(ctx.branding.logo, mode, origin, readLogoPng() !== null),
      unsubscribeUrl: externalUrl ? UNSUBSCRIBE_PLACEHOLDER : null,
      viewUrl: externalUrl ? VIEW_PLACEHOLDER : null,
      externalUrl,
      tracearrLinks: newsletter.links.tracearr,
      serversById,
      memberSend: ctx.memberSend,
    },
    { ...ctx.branding.branding, senderName },
    { newsletterId: newsletter.id, mode, externalUrl }
  );
  return { subject, senderName, fit };
}
