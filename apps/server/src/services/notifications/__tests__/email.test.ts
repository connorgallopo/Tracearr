import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import type { ViolationWithDetails } from '@tracearr/shared';

const mockSendMail = vi.fn();
const mockVerify = vi.fn();
const mockClose = vi.fn();
const mockCreateTransport = vi.fn((..._args: unknown[]) => ({
  sendMail: mockSendMail,
  verify: mockVerify,
  close: mockClose,
}));
vi.mock('nodemailer', () => ({
  createTransport: (...args: unknown[]) => mockCreateTransport(...args) as unknown,
}));

const mockProxyImage = vi.fn();
vi.mock('../../imageProxy.js', () => ({
  proxyImage: (...args: unknown[]) => mockProxyImage(...args) as unknown,
}));

const mockBuildMediaLinks = vi.fn();
vi.mock('../mediaLinks.js', () => ({
  buildMediaLinks: (...args: unknown[]) => mockBuildMediaLinks(...args) as unknown,
}));

const mockReadLogoPng = vi.fn();
vi.mock('../emailLogo.js', () => ({
  readLogoPng: () => mockReadLogoPng() as unknown,
}));

const mockGetNetworkSettings = vi.fn();
vi.mock('../../settings.js', () => ({
  getNetworkSettings: () => mockGetNetworkSettings() as unknown,
}));

const mockBranding = vi.fn();
vi.mock('../emailBranding.js', () => ({
  resolveEmailBranding: (...a: unknown[]) => mockBranding(...a) as unknown,
}));

import { createMockActiveSession } from '../../../test/fixtures.js';
import { _resetTransportersForTests } from '../destinations/emailTransport.js';
import { emailType, type EmailConfig, type EmailMessage } from '../destinations/email.js';
import type { NotificationEvent } from '../events.js';
import type { RenderContext } from '../destinations/types.js';

const config: EmailConfig = {
  preset: 'custom',
  host: 'smtp.example.com',
  port: '587',
  security: 'starttls',
  username: 'user',
  password: 'pw',
  fromName: 'Basement Plex',
  fromAddress: 'plex@example.com',
  to: 'a@example.com, b@example.org',
  replyTo: '',
  messagesPerSecond: '2',
};
const destination = { id: 'dest-1', name: 'Ops email' };
const systemCtx: RenderContext = { destination, source: { kind: 'system' } };
const deliverCtx = { destination, signal: AbortSignal.timeout(5000) };

const violation: ViolationWithDetails = {
  id: 'violation-123',
  ruleId: 'rule-456',
  serverUserId: 'user-789',
  sessionId: 'session-123',
  severity: 'warning',
  data: { reason: 'test violation' },
  acknowledgedAt: null,
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  user: {
    id: 'user-789',
    username: 'testuser',
    serverId: 'server-id',
    thumbUrl: null,
    identityName: 'Test User',
  },
  rule: { id: 'rule-456', name: 'Test Rule', type: 'concurrent_streams' },
  server: { id: 'server-id', name: 'Basement', type: 'plex' },
};

const mediaAdded: NotificationEvent = {
  type: 'media_added',
  payload: {
    serverId: 'server-1',
    serverName: 'Basement',
    serverType: 'plex',
    libraryItemId: 'item-1',
    ratingKey: 'rk-1',
    mediaId: null,
    title: 'Heat',
    grandparentTitle: null,
    parentTitle: null,
    grandparentRatingKey: null,
    parentRatingKey: null,
    parentIndex: null,
    itemIndex: null,
    mediaType: 'movie',
    year: 1995,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    thumbPath: '/library/metadata/1/thumb',
    libraryName: 'Movies',
    to: {
      resolution: '4k',
      dynamicRange: 'HDR10',
      videoCodec: 'hevc',
      audioCodec: 'truehd',
      audioChannels: 8,
      fileSize: null,
    },
  },
};

const newsletterSend = {
  type: 'newsletter_send',
  payload: {
    newsletterId: 'n-1',
    sendId: 'send-1',
    name: 'Weekly',
    outcome: 'partial',
    trigger: 'schedule',
    recipientCount: 42,
    itemCounts: { movies: 3, shows: 1, episodes: 4, albums: 0, mostWatched: 0 },
    error: null,
    windowStart: '2026-08-26T00:00:00.000Z',
    windowEnd: '2026-09-02T00:00:00.000Z',
    historyUrl: null,
  },
} as const;

const render = (event: NotificationEvent, ctx: RenderContext = systemCtx): Promise<EmailMessage> =>
  Promise.resolve(emailType.render(event, config, ctx));

beforeEach(() => {
  mockSendMail.mockReset().mockResolvedValue({ messageId: '<x@y>' });
  mockVerify.mockReset().mockResolvedValue(true);
  mockClose.mockReset();
  mockCreateTransport.mockClear();
  mockProxyImage.mockReset().mockResolvedValue({
    data: Buffer.from('jpegbytes'),
    contentType: 'image/jpeg',
    cached: true,
  });
  mockBuildMediaLinks
    .mockReset()
    .mockResolvedValue([{ label: 'Open in Plex', url: 'https://plex/x' }]);
  mockReadLogoPng.mockReset().mockReturnValue(Buffer.from('pngbytes'));
  mockGetNetworkSettings
    .mockReset()
    .mockResolvedValue({ externalUrl: 'https://tracearr.example.com', trustProxy: false });
  mockBranding.mockReset().mockResolvedValue({
    branding: { accentColor: '#0ea0b3', footerText: null, postalAddress: null },
    logo: { mode: 'tracearr' },
    mailtoUnsubscribe: false,
  });
});
afterEach(() => _resetTransportersForTests());

describe('emailType.render', () => {
  it('renders a violation as a facts card with the automation override winning', async () => {
    const event: NotificationEvent = { type: 'violation', payload: violation };
    const ctx: RenderContext = {
      destination,
      source: {
        kind: 'automation',
        automationId: 'a-1',
        automationName: 'Guard',
        title: 'Custom title',
        body: 'Custom body',
      },
    };
    const out = await render(event, ctx);
    expect(out.subject).toBe('Custom title');
    expect(out.html).toContain('Custom body');
    expect(out.html).toContain('Test User');
    expect(out.html).toContain('Test Rule');
    expect(out.html).toContain('href="https://tracearr.example.com"');
    expect(out.html).toMatch(/Server<!-- -->: <\/span>Basement/);
    expect(out.html).toContain('alt="Basement"');
    expect(out.attachments.map((a) => a.cid)).toEqual(['logo']);
  });

  it('renders a media event with the poster and logo attached inline and the links rendered', async () => {
    const out = await render(mediaAdded);
    expect(out.subject).toBe('New media added: Heat');
    expect(out.html).toContain('HDR10');
    expect(out.html).toContain('truehd 8ch');
    expect(out.html).toContain('src="cid:poster"');
    expect(out.html).toContain('src="cid:logo"');
    expect(out.html).toContain('href="https://plex/x"');
    expect(out.attachments).toEqual([
      {
        filename: 'logo.png',
        cid: 'logo',
        content: Buffer.from('pngbytes'),
        contentType: 'image/png',
      },
      {
        filename: 'poster.jpg',
        cid: 'poster',
        content: Buffer.from('jpegbytes'),
        contentType: 'image/jpeg',
      },
    ]);
    expect(mockProxyImage).toHaveBeenCalledWith({
      serverId: 'server-1',
      imagePath: '/library/metadata/1/thumb',
      width: 360,
      height: 540,
      fallback: 'poster',
    });
  });

  it('drops the poster when the proxy answers with a placeholder svg or throws', async () => {
    mockProxyImage.mockResolvedValueOnce({
      data: Buffer.from('<svg/>'),
      contentType: 'image/svg+xml',
      cached: false,
    });
    const svg = await render(mediaAdded);
    expect(svg.attachments.map((a) => a.cid)).toEqual(['logo']);
    expect(svg.html).not.toContain('cid:poster');

    mockProxyImage.mockRejectedValueOnce(new Error('offline'));
    const thrown = await render(mediaAdded);
    expect(thrown.attachments.map((a) => a.cid)).toEqual(['logo']);
  });

  it('renders through the branding block with the event server as the sender', async () => {
    mockBranding.mockResolvedValue({
      branding: { accentColor: '#123456', footerText: null, postalAddress: null },
      logo: { mode: 'tracearr' },
      mailtoUnsubscribe: false,
    });
    const out = await render(mediaAdded);
    expect(mockBranding).toHaveBeenCalledWith();
    expect(out.html).toContain('Sent by Tracearr for <!-- -->Basement');
    expect(out.html).toContain('#123456');
  });

  it('links the owner logo url instead of attaching the Tracearr png, and mode none renders none', async () => {
    mockBranding.mockResolvedValue({
      branding: { accentColor: '#0ea0b3', footerText: null, postalAddress: null },
      logo: { mode: 'url', url: 'https://x.test/l.png' },
      mailtoUnsubscribe: false,
    });
    const url = await render(mediaAdded);
    expect(url.html).toContain('src="https://x.test/l.png"');
    expect(url.attachments.map((a) => a.cid)).toEqual(['poster']);

    mockBranding.mockResolvedValue({
      branding: { accentColor: '#0ea0b3', footerText: null, postalAddress: null },
      logo: { mode: 'none' },
      mailtoUnsubscribe: false,
    });
    const none = await render(mediaAdded);
    expect(none.html).not.toContain('cid:logo');
    expect(none.attachments.map((a) => a.cid)).toEqual(['poster']);
  });

  it('omits the logo when none is on disk and the app link when no external url is set', async () => {
    mockReadLogoPng.mockReturnValue(null);
    mockGetNetworkSettings.mockResolvedValue({ externalUrl: null, trustProxy: false });
    const session = createMockActiveSession({
      server: { id: 's1', name: 'Attic Plex', type: 'plex' },
    });
    const out = await render({ type: 'session_started', payload: session });
    expect(out.attachments).toEqual([]);
    expect(out.html).not.toContain('Open Tracearr');
    expect(out.html).toContain('Attic Plex');
  });

  it('renders a newsletter outcome with Tracearr as the sender', async () => {
    const out = await render(newsletterSend, {
      destination,
      source: { kind: 'automation', automationId: 'a-1', automationName: 'Digest watch' },
    });
    expect(out.subject).toBe('Newsletter partly sent');
    expect(out.html).toContain('Weekly reached only part of its 42 recipients');
    expect(out.html).toContain('Sent by Tracearr for <!-- -->Tracearr');
  });
});

describe('emailType.deliver', () => {
  it('sends to every listed address with html, text, attachments and a message id', async () => {
    const message = await render(mediaAdded);
    await emailType.deliver(message, config, deliverCtx);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const sent = mockSendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      from: { name: 'Basement Plex', address: 'plex@example.com' },
      to: ['a@example.com', 'b@example.org'],
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments,
    });
    expect(sent).not.toHaveProperty('replyTo');
    expect(sent.messageId).toMatch(/^<[0-9a-f-]{36}@example\.com>$/);
    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com', port: 587, requireTLS: true })
    );
  });

  it('carries the message stream header when configured and omits it otherwise', async () => {
    const message = await render(mediaAdded);
    await emailType.deliver(message, { ...config, messageStream: 'broadcast' }, deliverCtx);
    expect(mockSendMail.mock.calls[0]?.[0]).toMatchObject({
      headers: { 'X-PM-Message-Stream': 'broadcast' },
    });

    await emailType.deliver(message, config, deliverCtx);
    expect(mockSendMail.mock.calls[1]?.[0]).not.toHaveProperty('headers');
  });

  it('passes reply-to when set and falls back to Tracearr as the from name', async () => {
    const message = await render(mediaAdded);
    await emailType.deliver(
      message,
      { ...config, fromName: '', replyTo: 'owner@example.com' },
      deliverCtx
    );
    expect(mockSendMail.mock.calls[0]?.[0]).toMatchObject({
      from: { name: 'Tracearr', address: 'plex@example.com' },
      replyTo: 'owner@example.com',
    });
  });

  it('throws when the send fails so the queue retries', async () => {
    mockSendMail.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'EMESSAGE' }));
    const message = await render(mediaAdded);
    await expect(emailType.deliver(message, config, deliverCtx)).rejects.toThrow('Ops email: nope');
  });

  it('declares a longer deliver timeout than the http kinds', () => {
    expect(emailType.deliverTimeoutMs).toBe(60_000);
  });

  it('reuses the cached transporter across two sends to the same destination', async () => {
    const message = await render(mediaAdded);
    await emailType.deliver(message, config, deliverCtx);
    await emailType.deliver(message, config, deliverCtx);
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });

  it('refuses an empty alert list before touching SMTP and keeps the sentence intact', async () => {
    const message = await render(mediaAdded);
    for (const to of ['', null, undefined]) {
      await expect(emailType.deliver(message, { ...config, to }, deliverCtx)).rejects.toThrow(
        /^No alert recipients on this destination\. Add one under Settings, Destinations\.$/
      );
    }
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });

  it('throws bullmq UnrecoverableError for an empty alert list so the job skips retries', async () => {
    const message = await render(mediaAdded);
    await expect(emailType.deliver(message, { ...config, to: '' }, deliverCtx)).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(UnrecoverableError);
        expect((error as Error).name).toBe('UnrecoverableError');
        expect((error as Error).message).toBe(
          'No alert recipients on this destination. Add one under Settings, Destinations.'
        );
        return true;
      }
    );
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

describe('emailType.test', () => {
  it('verifies before sending and closes the uncached transporter', async () => {
    await emailType.test(config, deliverCtx);
    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockVerify.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendMail.mock.invocationCallOrder[0] ?? 0
    );
    expect(mockSendMail.mock.calls[0]?.[0]).toMatchObject({
      to: ['a@example.com', 'b@example.org'],
      subject: 'Test email from Tracearr (Ops email)',
    });
    expect(mockBranding).toHaveBeenCalledWith();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('renders the test email through the branding block and skips the logo it does not use', async () => {
    mockBranding.mockResolvedValue({
      branding: { accentColor: '#123456', footerText: null, postalAddress: null },
      logo: { mode: 'none' },
      mailtoUnsubscribe: false,
    });
    await emailType.test(config, deliverCtx);
    const sent = mockSendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(sent.html)).toContain('Sent by Tracearr for <!-- -->Tracearr');
    expect(String(sent.html)).toContain('#123456');
    expect(String(sent.html)).not.toContain('cid:logo');
    expect(sent.attachments).toEqual([]);
  });

  it('turns an auth failure into a readable message and still closes', async () => {
    mockVerify.mockRejectedValueOnce(Object.assign(new Error('535'), { code: 'EAUTH' }));
    await expect(emailType.test(config, deliverCtx)).rejects.toThrow(
      'SMTP authentication failed for user at smtp.example.com'
    );
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('reports the listed addresses it sent to', async () => {
    await expect(emailType.test(config, deliverCtx)).resolves.toEqual({
      sentTo: 'a@example.com, b@example.org',
    });
  });

  it('falls back to the from address when the alert list is empty and says so', async () => {
    await expect(emailType.test({ ...config, to: '' }, deliverCtx)).resolves.toEqual({
      sentTo: 'plex@example.com',
    });
    expect(mockSendMail.mock.calls[0]?.[0]).toMatchObject({ to: ['plex@example.com'] });
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });
});
