import type { NewsletterPreview, NewsletterPreviewVariant } from '@tracearr/shared';
import { resolveEmailBranding } from '../notifications/emailBranding.js';
import { getNetworkSettings } from '../settings.js';
import { resolveRecipients } from './recipients.js';
import { digestForBrowser } from './snapshot.js';
import { loadServerLinks, type NewsletterRow } from './store.js';
import { assembleVariant, renderVariant, type VariantRenderContext } from './variantRender.js';
import { orderServers, planVariants } from './variants.js';
import { computeWindow } from './window.js';

/** A saved row or an unsaved form: every field the preview reads, and an id that only reaches log lines. */
export type PreviewSource = Pick<
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
  | 'window'
  | 'recipients'
>;

export async function buildPreview(
  newsletter: PreviewSource,
  lastWindowEnd: Date | null
): Promise<NewsletterPreview> {
  const window = computeWindow(newsletter.window, lastWindowEnd, new Date());
  const [{ externalUrl }, links, resolution, branding] = await Promise.all([
    getNetworkSettings(),
    loadServerLinks(newsletter.scope.serverIds),
    resolveRecipients(newsletter),
    resolveEmailBranding(),
  ]);
  const servers = orderServers(newsletter.scope, links);
  // Preview shows a member what a real send looks like, not a test send.
  const ctx: VariantRenderContext = {
    newsletter,
    window,
    externalUrl,
    branding,
    servers,
    memberSend: true,
  };
  const rendered: NewsletterPreviewVariant[] = [];
  for (const variant of planVariants(servers, resolution).variants) {
    const { data, posters } = await assembleVariant(ctx, variant);
    const out = await renderVariant(ctx, variant, data, posters);
    rendered.push({
      key: variant.key,
      serverIds: variant.serverIds,
      serverNames: variant.serverNames,
      recipientCount: variant.recipients.filter((r) => !r.suppressed).length,
      subject: out.subject,
      html: digestForBrowser(out.fit.rendered.html, posters),
      counts: data.counts,
      trimmed: out.fit.trimmed,
    });
  }
  const [union, ...rest] = rendered;
  if (!union) throw new Error('planVariants always lists the union');
  const suppressed = resolution.recipients.filter((r) => r.suppressed).length;
  return {
    window: {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      fromWatermark: lastWindowEnd !== null && window.start.getTime() === lastWindowEnd.getTime(),
    },
    recipients: {
      resolved: resolution.recipients.length - suppressed,
      missingEmail: resolution.missing.length,
      suppressed,
    },
    variants: [union, ...rest],
  };
}
