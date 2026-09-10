import type { FastifyReply } from 'fastify';

/** Sized for shared keys: without trustProxy every member behind one proxy shares an IP. */
export const PUBLIC_RATE_LIMIT = { max: 60, timeWindow: '1 minute' };

const CSP_TEXT = "default-src 'none'; style-src 'unsafe-inline'";
const CSP_IMAGES = "default-src 'none'; img-src 'self' https:; style-src 'unsafe-inline'";

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8eb;margin:0;padding:48px 16px}main{max-width:480px;margin:0 auto;background:#1a1d23;border:1px solid #2a2e36;border-radius:8px;padding:24px}button{background:#0ea0b3;color:#fff;border:0;border-radius:6px;padding:10px 16px;font-size:16px}</style></head><body><main><h1 style="font-size:20px;margin:0 0 12px">${title}</h1>${body}</main></body></html>`;
}

/** Never names the address: a forwarded link must not disclose who received the digest. */
export function sendPublicPage(
  reply: FastifyReply,
  status: number,
  html: string,
  images = false
): FastifyReply {
  return reply
    .code(status)
    .header('X-Robots-Tag', 'noindex')
    .header('Cache-Control', 'private, no-store')
    .header('Content-Security-Policy', images ? CSP_IMAGES : CSP_TEXT)
    .type('text/html; charset=utf-8')
    .send(html);
}
