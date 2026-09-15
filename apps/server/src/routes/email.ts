import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  emailBrandingSchema,
  emailSuppressionCreateSchema,
  resolveSenderName,
} from '@tracearr/shared';
import {
  UNSUBSCRIBE_TOKEN_MAX_LENGTH,
  verifyUnsubscribeToken,
} from '../services/newsletters/links.js';
import {
  loadDelivery,
  loadServerLinks,
  type DeliveryContext,
} from '../services/newsletters/store.js';
import {
  addSuppression,
  listSuppressions,
  removeSuppression,
} from '../services/newsletters/suppressions.js';
import { getEmailBranding, saveEmailBranding } from '../services/notifications/emailBranding.js';
import { firstIssueMessage } from '../utils/zod.js';
import { PUBLIC_RATE_LIMIT, page, sendPublicPage } from './publicPage.js';

const tokenParams = z.object({ token: z.string().min(1).max(UNSUBSCRIBE_TOKEN_MAX_LENGTH) });
const addressParams = z.object({ address: z.string().min(3).max(254) });

const INVALID = page(
  'This link is not valid',
  '<p>The unsubscribe link is incomplete or has expired. Reply to the email you received and the sender will remove you.</p>'
);

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  );

async function deliveryFor(params: unknown): Promise<DeliveryContext | null> {
  const parsed = tokenParams.safeParse(params);
  const recipientId = parsed.success ? verifyUnsubscribeToken(parsed.data.token) : null;
  return recipientId ? loadDelivery(recipientId) : null;
}

/** The name the email was shown as, so the page names the sender the member recognizes; page() does not escape. */
async function senderNameFor(ctx: DeliveryContext): Promise<string> {
  const servers = await loadServerLinks(ctx.newsletter.scope.serverIds);
  return escapeHtml(
    resolveSenderName(
      ctx.newsletter.senderName,
      servers.map((s) => s.name)
    )
  );
}

export async function emailRoutes(app: FastifyInstance): Promise<void> {
  const owner = { preHandler: [app.requireOwner] };

  // The unsubscribe POST arrives as a one-click client's form body or a plain
  // browser submit; the body is never read, so any bytes parse fine as a string.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body)
  );

  app.get('/suppressions', owner, async () => listSuppressions());

  app.post('/suppressions', owner, async (request, reply) => {
    const parsed = emailSuppressionCreateSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.badRequest(`Invalid request body: ${firstIssueMessage(parsed.error)}`);
    await addSuppression(parsed.data.address, 'manual');
    return reply.code(201).send({ address: parsed.data.address });
  });

  app.delete('/suppressions/:address', owner, async (request, reply) => {
    const params = addressParams.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid address');
    const removed = await removeSuppression(params.data.address);
    if (!removed) return reply.notFound('Address is not suppressed');
    return reply.code(204).send();
  });

  app.get('/branding', owner, async () => getEmailBranding());

  app.put('/branding', owner, async (request, reply) => {
    const parsed = emailBrandingSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.badRequest(`Invalid request body: ${firstIssueMessage(parsed.error)}`);
    return saveEmailBranding(parsed.data);
  });

  const publicRoute = { config: { rateLimit: PUBLIC_RATE_LIMIT } };

  app.get('/unsubscribe/:token', publicRoute, async (request, reply) => {
    const ctx = await deliveryFor(request.params);
    if (!ctx) return sendPublicPage(reply, 404, INVALID);
    const sender = await senderNameFor(ctx);
    return sendPublicPage(
      reply,
      200,
      page(
        'Unsubscribe from all newsletters?',
        `<p>Unsubscribe this address from all newsletters sent by ${sender}?</p><form method="post"><button type="submit">Unsubscribe</button></form>`
      )
    );
  });

  app.post('/unsubscribe/:token', publicRoute, async (request, reply) => {
    const ctx = await deliveryFor(request.params);
    if (!ctx) return sendPublicPage(reply, 404, INVALID);
    await addSuppression(ctx.recipient.address, 'unsubscribed', ctx.send.id);
    const sender = await senderNameFor(ctx);
    return sendPublicPage(
      reply,
      200,
      page(
        'You are unsubscribed',
        `<p>This address will not receive newsletters from ${sender} again.</p>`
      )
    );
  });
}
