import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createNewsletterSchema,
  newsletterSendsQuerySchema,
  newsletterTestSendSchema,
  resolveSenderName,
  updateNewsletterSchema,
  uuidSchema,
  NEWSLETTER_VIEW_TOKEN_LENGTH,
  type Newsletter,
  type NewsletterPreview,
  type NewsletterRecipientsView,
  type NewsletterSendHtml,
} from '@tracearr/shared';
import { isUniqueViolation } from '../db/pg.js';
import {
  InvalidScheduleError,
  enqueueDeliveries,
  enqueueNewsletterRun,
  nextRunAt,
  removeNewsletterSchedule,
  upsertNewsletterSchedule,
} from '../jobs/newsletterQueue.js';
import { assembleDigest } from '../services/newsletters/assemble.js';
import { renderDigestToFit } from '../services/newsletters/fit.js';
import { resolveRecipients } from '../services/newsletters/recipients.js';
import {
  UNSUBSCRIBE_PLACEHOLDER,
  VIEW_PLACEHOLDER,
  formatWindowDate,
  logoRefFor,
  resolveImageMode,
} from '../services/newsletters/render.js';
import { digestForBrowser, snapshotForBrowser } from '../services/newsletters/snapshot.js';
import {
  createNewsletter,
  deleteNewsletter,
  findOpenSend,
  getNewsletter,
  getSend,
  getSendByViewToken,
  lastSend,
  lastWatermark,
  listNewsletters,
  listRecipients,
  listSends,
  loadServerLinks,
  resetFailedRecipients,
  toPublicNewsletter,
  toRecipient,
  toSendSummary,
  updateNewsletter,
  type NewsletterRow,
  type SendRow,
} from '../services/newsletters/store.js';
import { computeWindow } from '../services/newsletters/window.js';
import { getDestination } from '../services/notifications/destinationStore.js';
import { resolveEmailBranding } from '../services/notifications/emailBranding.js';
import { readLogoPng } from '../services/notifications/emailLogo.js';
import { renderTemplate } from '../services/notifications/types.js';
import { getNetworkSettings } from '../services/settings.js';
import { firstIssueMessage } from '../utils/zod.js';
import { PUBLIC_RATE_LIMIT, page, sendPublicPage } from './publicPage.js';

const DUPLICATE_NAME = 'A newsletter with that name already exists';

const idParams = z.object({ id: uuidSchema });
const sendParams = z.object({ id: uuidSchema, sendId: uuidSchema });
const viewParams = z.object({
  token: z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${NEWSLETTER_VIEW_TOKEN_LENGTH}}$`)),
});
const NOT_AVAILABLE = page(
  'This newsletter is not available',
  '<p>The link is incomplete, or the newsletter has been removed.</p>'
);

/** The checks a body must pass beyond its shape: the transport must be an email kind and hosted needs a public url. */
async function validateReferences(input: {
  destinationId?: string | null;
  imageMode?: string;
}): Promise<string | null> {
  if (input.destinationId) {
    const destination = await getDestination(input.destinationId);
    if (!destination || destination.type !== 'email')
      return 'destinationId must name an email destination';
  }
  if (input.imageMode === 'hosted') {
    const { externalUrl } = await getNetworkSettings();
    if (!externalUrl) return 'Hosted images need the external URL set first';
  }
  return null;
}

async function publicOf(row: NewsletterRow): Promise<Newsletter> {
  const [last, next] = await Promise.all([lastSend(row.id), nextRunAt(row.id).catch(() => null)]);
  return toPublicNewsletter(row, last, next);
}

/** The send when it belongs to the newsletter; null otherwise, so callers reply notFound without leaking a cross-newsletter row. */
async function ownedSend(newsletterId: string, sendId: string): Promise<SendRow | null> {
  const send = await getSend(sendId);
  return send && send.newsletterId === newsletterId ? send : null;
}

export async function newsletterRoutes(app: FastifyInstance): Promise<void> {
  const owner = { preHandler: [app.requireOwner] };

  app.get('/', owner, async () => {
    const rows = await listNewsletters();
    return Promise.all(rows.map(publicOf));
  });

  app.post('/', owner, async (request, reply) => {
    const parsed = createNewsletterSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.badRequest(`Invalid request body: ${firstIssueMessage(parsed.error)}`);
    const problem = await validateReferences(parsed.data);
    if (problem) return reply.badRequest(problem);
    let row;
    try {
      row = await createNewsletter(parsed.data);
    } catch (error) {
      if (isUniqueViolation(error)) return reply.conflict(DUPLICATE_NAME);
      throw error;
    }
    try {
      await upsertNewsletterSchedule(row);
    } catch (error) {
      if (error instanceof InvalidScheduleError) {
        await deleteNewsletter(row.id);
        return reply.badRequest(`Invalid schedule: ${error.message}`);
      }
      throw error;
    }
    return reply.code(201).send(await publicOf(row));
  });

  app.get('/view/:token', { config: { rateLimit: PUBLIC_RATE_LIMIT } }, async (request, reply) => {
    const params = viewParams.safeParse(request.params);
    const send = params.success ? await getSendByViewToken(params.data.token) : null;
    const html = send ? snapshotForBrowser(send) : null;
    if (!html) return sendPublicPage(reply, 404, NOT_AVAILABLE);
    return sendPublicPage(reply, 200, html, true);
  });

  app.get('/:id', owner, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid id');
    const row = await getNewsletter(params.data.id);
    if (!row) return reply.notFound('Newsletter not found');
    return publicOf(row);
  });

  app.patch('/:id', owner, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid id');
    const parsed = updateNewsletterSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.badRequest(`Invalid request body: ${firstIssueMessage(parsed.error)}`);
    const current = await getNewsletter(params.data.id);
    if (!current) return reply.notFound('Newsletter not found');
    const patch = parsed.data;
    const problem = await validateReferences({
      destinationId: 'destinationId' in patch ? patch.destinationId : current.destinationId,
      imageMode: 'imageMode' in patch ? patch.imageMode : current.imageMode,
    });
    if (problem) return reply.badRequest(problem);
    let row;
    try {
      row = await updateNewsletter(params.data.id, patch);
    } catch (error) {
      if (isUniqueViolation(error)) return reply.conflict(DUPLICATE_NAME);
      throw error;
    }
    if (!row) return reply.notFound('Newsletter not found');
    try {
      await upsertNewsletterSchedule(row);
    } catch (error) {
      if (error instanceof InvalidScheduleError)
        return reply.badRequest(`Invalid schedule: ${error.message}`);
      throw error;
    }
    return publicOf(row);
  });

  app.delete('/:id', owner, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid id');
    const result = await deleteNewsletter(params.data.id);
    if (result === 'missing') return reply.notFound('Newsletter not found');
    if (result === 'open_send')
      return reply.conflict('A send is in progress; wait for it to finish');
    await removeNewsletterSchedule(params.data.id);
    return reply.code(204).send();
  });

  app.post('/:id/preview', owner, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid id');
    const row = await getNewsletter(params.data.id);
    if (!row) return reply.notFound('Newsletter not found');
    const now = new Date();
    const window = computeWindow(row.window, await lastWatermark(row.id), now);
    const [{ externalUrl }, { data, posters }, resolution, servers] = await Promise.all([
      getNetworkSettings(),
      assembleDigest(row, window),
      resolveRecipients(row),
      loadServerLinks(row.scope.serverIds),
    ]);
    const senderName = resolveSenderName(
      row.senderName,
      servers.map((s) => s.name)
    );
    const { branding, logo } = await resolveEmailBranding();
    const mode = resolveImageMode(row.imageMode, externalUrl);
    const origin = externalUrl?.replace(/\/$/, '') ?? '';
    const subject = renderTemplate(row.subject, {
      server_name: senderName,
      start_date: formatWindowDate(window.start, row.timezone),
      end_date: formatWindowDate(window.end, row.timezone),
      item_count: String(data.counts.movies + data.counts.episodes + data.counts.albums),
    });
    const fit = await renderDigestToFit(
      data,
      posters,
      {
        subject,
        intro: row.intro,
        outro: row.outro,
        windowStart: formatWindowDate(window.start, row.timezone),
        windowEnd: formatWindowDate(window.end, row.timezone),
        logoRef: logoRefFor(logo, mode, origin, readLogoPng() !== null),
        unsubscribeUrl: externalUrl ? UNSUBSCRIBE_PLACEHOLDER : null,
        viewUrl: externalUrl ? VIEW_PLACEHOLDER : null,
        externalUrl,
        tracearrLinks: row.links.tracearr,
        serversById: new Map(servers.map((s) => [s.id, s])),
      },
      { ...branding, senderName },
      { newsletterId: row.id, mode, externalUrl }
    );
    const suppressed = resolution.recipients.filter((r) => r.suppressed).length;
    const preview: NewsletterPreview = {
      subject,
      html: digestForBrowser(fit.rendered.html, posters),
      counts: data.counts,
      trimmed: fit.trimmed,
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
      recipients: {
        resolved: resolution.recipients.length - suppressed,
        missingEmail: resolution.missing.length,
        suppressed,
      },
    };
    return preview;
  });

  app.post('/:id/test', owner, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid id');
    const parsed = newsletterTestSendSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.badRequest(`Invalid request body: ${firstIssueMessage(parsed.error)}`);
    const row = await getNewsletter(params.data.id);
    if (!row) return reply.notFound('Newsletter not found');
    if (!row.destinationId) return reply.badRequest('Set an email destination first');
    if (await findOpenSend(row.id)) return reply.conflict('A send is already in progress');
    const jobId = await enqueueNewsletterRun({
      newsletterId: row.id,
      trigger: 'test',
      testAddress: parsed.data.address,
    });
    return reply.code(202).send({ queued: true, jobId });
  });

  app.post('/:id/send', owner, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid id');
    const row = await getNewsletter(params.data.id);
    if (!row) return reply.notFound('Newsletter not found');
    if (!row.destinationId) return reply.badRequest('Set an email destination first');
    if (await findOpenSend(row.id)) return reply.conflict('A send is already in progress');
    const jobId = await enqueueNewsletterRun({ newsletterId: row.id, trigger: 'manual' });
    return reply.code(202).send({ queued: true, jobId });
  });

  app.get('/:id/recipients', owner, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid id');
    const row = await getNewsletter(params.data.id);
    if (!row) return reply.notFound('Newsletter not found');
    const view: NewsletterRecipientsView = await resolveRecipients(row);
    return view;
  });

  app.get('/:id/sends', owner, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid id');
    const query = newsletterSendsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.badRequest('Invalid query');
    const { rows, total } = await listSends(params.data.id, query.data.page, query.data.pageSize);
    return {
      sends: rows.map(toSendSummary),
      total,
      page: query.data.page,
      pageSize: query.data.pageSize,
    };
  });

  app.get('/:id/sends/:sendId', owner, async (request, reply) => {
    const params = sendParams.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid id');
    const send = await ownedSend(params.data.id, params.data.sendId);
    if (!send) return reply.notFound('Send not found');
    const recipients = await listRecipients(send.id);
    return { ...toSendSummary(send), recipients: recipients.map(toRecipient) };
  });

  app.get('/:id/sends/:sendId/html', owner, async (request, reply) => {
    const params = sendParams.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid id');
    const send = await ownedSend(params.data.id, params.data.sendId);
    if (!send) return reply.notFound('Send not found');
    const html = snapshotForBrowser(send);
    if (!html) return reply.notFound('The snapshot has been pruned');
    const body: NewsletterSendHtml = { subject: send.subject, html };
    return body;
  });

  app.post('/:id/sends/:sendId/retry-failed', owner, async (request, reply) => {
    const params = sendParams.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid id');
    const send = await ownedSend(params.data.id, params.data.sendId);
    if (!send) return reply.notFound('Send not found');
    if (send.html === null)
      return reply.conflict('The snapshot for this send has been pruned; nothing can be resent');
    const ids = await resetFailedRecipients(send.id);
    const queued = await enqueueDeliveries(send.id, ids);
    return reply.code(202).send({ queued });
  });
}
