import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { emailSuppressionCreateSchema } from '@tracearr/shared';
import { verifyUnsubscribeToken } from '../services/newsletters/links.js';
import { loadDelivery } from '../services/newsletters/store.js';
import {
  addSuppression,
  listSuppressions,
  removeSuppression,
} from '../services/newsletters/suppressions.js';
import { firstIssueMessage } from '../utils/zod.js';

const PUBLIC_RATE_LIMIT = { max: 60, timeWindow: '1 minute' };
const tokenParams = z.object({ token: z.string().min(1).max(128) });
const addressParams = z.object({ address: z.string().min(3).max(254) });

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8eb;margin:0;padding:48px 16px}main{max-width:480px;margin:0 auto;background:#1a1d23;border:1px solid #2a2e36;border-radius:8px;padding:24px}button{background:#0ea0b3;color:#fff;border:0;border-radius:6px;padding:10px 16px;font-size:16px}</style></head><body><main><h1 style="font-size:20px;margin:0 0 12px">${title}</h1>${body}</main></body></html>`;
}

/** Never names the address: a forwarded link must not disclose who received the digest. */
function sendPage(reply: FastifyReply, status: number, html: string): FastifyReply {
  return reply
    .code(status)
    .header('X-Robots-Tag', 'noindex')
    .header('Cache-Control', 'private, no-store')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    .type('text/html; charset=utf-8')
    .send(html);
}

const INVALID = page(
  'This link is not valid',
  '<p>The unsubscribe link is incomplete or has expired. Reply to the email you received and the sender will remove you.</p>'
);

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
    const removed = await removeSuppression(decodeURIComponent(params.data.address));
    if (!removed) return reply.notFound('Address is not suppressed');
    return reply.code(204).send();
  });

  const publicRoute = { config: { rateLimit: PUBLIC_RATE_LIMIT } };

  app.get('/unsubscribe/:token', publicRoute, async (request, reply) => {
    const params = tokenParams.safeParse(request.params);
    const recipientId = params.success ? verifyUnsubscribeToken(params.data.token) : null;
    const ctx = recipientId ? await loadDelivery(recipientId) : null;
    if (!ctx) return sendPage(reply, 404, INVALID);
    return sendPage(
      reply,
      200,
      page(
        'Unsubscribe from this newsletter?',
        '<p>You will stop receiving this newsletter at this address.</p><form method="post"><button type="submit">Unsubscribe</button></form>'
      )
    );
  });

  app.post('/unsubscribe/:token', publicRoute, async (request, reply) => {
    const params = tokenParams.safeParse(request.params);
    const recipientId = params.success ? verifyUnsubscribeToken(params.data.token) : null;
    const ctx = recipientId ? await loadDelivery(recipientId) : null;
    if (!ctx) return sendPage(reply, 404, INVALID);
    await addSuppression(ctx.recipient.address, 'unsubscribed', ctx.send.id);
    return sendPage(
      reply,
      200,
      page('You are unsubscribed', '<p>This address will not receive the newsletter again.</p>')
    );
  });
}
