import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EMAIL_BRANDING } from '@tracearr/shared';
import type * as EmailTransportModule from '../../notifications/destinations/emailTransport.js';

const store = vi.hoisted(() => ({
  loadDelivery: vi.fn(),
  beginAttempt: vi.fn(),
  markRecipient: vi.fn(),
  noteRecipientError: vi.fn(),
  finalizeSend: vi.fn(),
}));
vi.mock('../store.js', () => store);
const mockAnnounce = vi.hoisted(() => vi.fn());
vi.mock('../events.js', () => ({
  announceSendFinished: (...a: unknown[]) => mockAnnounce(...a) as unknown,
}));
const mockSendMail = vi.fn();
const mockGetTransporter = vi.fn((..._args: unknown[]) => ({ sendMail: mockSendMail }));
vi.mock('../../notifications/destinations/emailTransport.js', async (importActual) => {
  const actual = await importActual<typeof EmailTransportModule>();
  return {
    ...actual,
    getTransporter: (...a: unknown[]) => mockGetTransporter(...a) as unknown,
  };
});
const mockDestination = vi.fn();
const mockReadConfig = vi.fn();
const mockRewrapConfig = vi.fn();
vi.mock('../../notifications/destinationStore.js', () => ({
  getDestination: (...a: unknown[]) => mockDestination(...a) as unknown,
  readConfig: (...a: unknown[]) => mockReadConfig(...a) as unknown,
  rewrapConfig: (...a: unknown[]) => mockRewrapConfig(...a) as unknown,
}));
const mockProxy = vi.fn();
vi.mock('../../imageProxy.js', () => ({
  proxyImage: (...a: unknown[]) => mockProxy(...a) as unknown,
  buildProxyUrl: (o: {
    serverId: string;
    path: string;
    width?: number;
    height?: number;
    fallback?: string;
    version?: string;
  }) => {
    const { serverId, path, width = 300, height = 450, fallback = 'poster', version } = o;
    const params = new URLSearchParams({
      server: serverId,
      url: path,
      width: String(width),
      height: String(height),
      fallback,
    });
    if (version) params.set('v', version);
    return `/api/v1/images/proxy?${params}`;
  },
  posterVersionFor: (path: string) => path,
}));
vi.mock('../../notifications/emailLogo.js', () => ({ readLogoPng: () => Buffer.from('png') }));
const mockBranding = vi.fn();
vi.mock('../../notifications/emailBranding.js', () => ({
  getEmailBranding: (...a: unknown[]) => mockBranding(...a) as unknown,
}));
const mockSettings = vi.fn();
vi.mock('../../settings.js', () => ({ getNetworkSettings: () => mockSettings() as unknown }));
vi.mock('../links.js', () => ({ signUnsubscribeToken: (id: string) => `tok-${id}` }));

import { deliverRecipient, markRecipientFailed } from '../deliver.js';

const VIEW_TOKEN = 'v'.repeat(43);
const VIEW_URL = `https://tracearr.example.com/api/v1/newsletters/view/${VIEW_TOKEN}`;
const UNSUBSCRIBE_URL = 'https://tracearr.example.com/api/v1/email/unsubscribe/tok-r1';

const config = {
  host: 'smtp.example.com',
  port: '587',
  security: 'starttls',
  username: 'u',
  password: 'p',
  fromName: 'Basement',
  fromAddress: 'plex@example.com',
  to: 'owner@example.com',
  replyTo: 'owner@example.com',
  messagesPerSecond: '2',
};
const ctx = () => ({
  recipient: {
    id: 'r1',
    sendId: 'send-1',
    address: 'a@x.com',
    userId: 'u1',
    variantKey: 's1',
    status: 'queued',
    attempts: 0,
    error: null,
    messageId: null,
    sentAt: null,
  },
  send: { id: 'send-1', newsletterId: 'n1', destinationId: 'd1', outcome: 'sending' },
  newsletter: { id: 'n1', imageMode: 'auto' },
  snapshot: {
    sendId: 'send-1',
    variantKey: 's1',
    viewToken: VIEW_TOKEN,
    subject: 'x',
    html: '<img src="cid:logo"><p>Hi</p><img src="poster:m1" alt="Heat"><p><a href="{{view_url}}">View in browser</a></p><a href="{{unsubscribe_url}}">Unsubscribe</a>',
    text: 'Hi\nView [{{view_url}}]\nUnsubscribe [{{unsubscribe_url}}]',
    posters: { m1: { serverId: 's1', thumbPath: '/t', version: 'v1' } },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockBranding.mockResolvedValue({ ...DEFAULT_EMAIL_BRANDING, mailtoUnsubscribe: false });
  store.loadDelivery.mockResolvedValue(ctx());
  store.beginAttempt.mockResolvedValue({
    previousMessageId: null,
    previousError: null,
    attempts: 1,
  });
  mockDestination.mockResolvedValue({
    id: 'd1',
    name: 'Mail',
    type: 'email',
    enabled: true,
    configStatus: 'ok',
  });
  mockReadConfig.mockReturnValue({ ok: true, config, rewrap: false });
  mockProxy.mockResolvedValue({
    data: Buffer.from('jpeg'),
    contentType: 'image/jpeg',
    cached: true,
  });
  mockSettings.mockResolvedValue({
    externalUrl: 'https://tracearr.example.com',
    trustProxy: false,
  });
  mockSendMail.mockResolvedValue({ messageId: '<x>' });
  store.finalizeSend.mockResolvedValue('sent');
});

describe('deliverRecipient', () => {
  it('substitutes the token, attaches logo and poster inline, sets the unsubscribe headers, and records sent', async () => {
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    expect(store.beginAttempt).toHaveBeenCalledWith(
      'r1',
      expect.stringMatching(/^<[0-9a-f-]{36}@example\.com>$/)
    );
    expect(mockGetTransporter).toHaveBeenCalledWith('d1', config);
    const mail = mockSendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mail).toMatchObject({
      from: { name: 'Basement', address: 'plex@example.com' },
      to: ['a@x.com'],
      replyTo: 'owner@example.com',
      subject: 'x',
      headers: {
        'List-Unsubscribe': `<${UNSUBSCRIBE_URL}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    expect(String(mail.html)).toContain(`href="${UNSUBSCRIBE_URL}"`);
    expect(String(mail.html)).toContain(`href="${VIEW_URL}"`);
    expect(String(mail.html)).not.toContain('{{view_url}}');
    expect(String(mail.html)).toContain('src="cid:m1"');
    expect(String(mail.text)).toContain(UNSUBSCRIBE_URL);
    expect(String(mail.text)).toContain(VIEW_URL);
    expect(String(mail.text)).not.toContain('{{view_url}}');
    expect((mail.attachments as { cid: string }[]).map((a) => a.cid)).toEqual(['logo', 'm1']);
    expect(mockProxy).toHaveBeenCalledWith({
      serverId: 's1',
      imagePath: '/t',
      width: 360,
      height: 540,
      fallback: 'poster',
      version: 'v1',
    });
    expect(store.markRecipient).toHaveBeenCalledWith('r1', 'sent');
    expect(store.finalizeSend).toHaveBeenCalledWith('send-1');
    expect(mockAnnounce).toHaveBeenCalledWith('send-1');
  });

  it('does not announce when finalizeSend leaves the send open for another delivery to close', async () => {
    store.finalizeSend.mockResolvedValueOnce(null);
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    expect(store.finalizeSend).toHaveBeenCalledWith('send-1');
    expect(mockAnnounce).not.toHaveBeenCalled();
  });

  it('sends no unsubscribe headers without an external url', async () => {
    mockSettings.mockResolvedValue({ externalUrl: null, trustProxy: false });
    store.loadDelivery.mockResolvedValue({
      ...ctx(),
      snapshot: { ...ctx().snapshot, html: '<p>Hi</p>', text: 'Hi' },
    });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    const mail = mockSendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mail.headers).toBeUndefined();
  });

  it('attaches no logo when the rendered snapshot never referenced cid:logo', async () => {
    store.loadDelivery.mockResolvedValue({
      ...ctx(),
      snapshot: {
        ...ctx().snapshot,
        html: '<p>Hi</p><img src="poster:m1" alt="Heat"><a href="{{unsubscribe_url}}">Unsubscribe</a>',
      },
    });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    const mail = mockSendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((mail.attachments as { cid: string }[]).map((a) => a.cid)).toEqual(['m1']);
  });

  it('leaves a poster the rendered html never referenced unfetched and unattached', async () => {
    const withOrphan = ctx();
    store.loadDelivery.mockResolvedValue({
      ...withOrphan,
      snapshot: {
        ...withOrphan.snapshot,
        posters: {
          m1: { serverId: 's1', thumbPath: '/t', version: 'v1' },
          w9: { serverId: 's1', thumbPath: '/watched', version: 'v2' },
        },
      },
    });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    const mail = mockSendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((mail.attachments as { cid: string }[]).map((a) => a.cid)).toEqual(['logo', 'm1']);
    expect(mockProxy).toHaveBeenCalledTimes(1);
    expect(mockProxy).toHaveBeenCalledWith(expect.objectContaining({ imagePath: '/t' }));
  });

  it('carries the mailto form alongside the https one when the owner turned it on', async () => {
    mockBranding.mockResolvedValue({ ...DEFAULT_EMAIL_BRANDING, mailtoUnsubscribe: true });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    const mail = mockSendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mail.headers).toEqual({
      'List-Unsubscribe': `<mailto:owner@example.com?subject=unsubscribe>, <${UNSUBSCRIBE_URL}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('keeps the https form alone when the mailto form has no reply-to address', async () => {
    mockBranding.mockResolvedValue({ ...DEFAULT_EMAIL_BRANDING, mailtoUnsubscribe: true });
    mockReadConfig.mockReturnValue({ ok: true, config: { ...config, replyTo: '' }, rewrap: false });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    const mail = mockSendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mail.headers).toEqual({
      'List-Unsubscribe': `<${UNSUBSCRIBE_URL}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('keeps the unsubscribe link but drops the one-click header when the external url is http', async () => {
    mockSettings.mockResolvedValue({
      externalUrl: 'http://tracearr.example.com',
      trustProxy: false,
    });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    const mail = mockSendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mail.headers).toEqual({
      'List-Unsubscribe': '<http://tracearr.example.com/api/v1/email/unsubscribe/tok-r1>',
    });
    expect(String(mail.html)).toContain(
      'href="http://tracearr.example.com/api/v1/email/unsubscribe/tok-r1"'
    );
  });

  it('refuses to send a snapshot whose placeholders can no longer be filled in', async () => {
    mockSettings.mockResolvedValue({ externalUrl: null, trustProxy: false });
    await expect(deliverRecipient({ sendId: 'send-1', recipientId: 'r1' })).rejects.toThrow(
      'The external URL was removed after this send was rendered'
    );
    store.loadDelivery.mockResolvedValue({
      ...ctx(),
      snapshot: {
        ...ctx().snapshot,
        html: '<p><a href="{{view_url}}">View in browser</a></p>',
        text: 'View [{{view_url}}]',
      },
    });
    await expect(deliverRecipient({ sendId: 'send-1', recipientId: 'r1' })).rejects.toThrow(
      'The external URL was removed after this send was rendered'
    );
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('throws unrecoverably when the recipient variant has no snapshot', async () => {
    store.loadDelivery.mockResolvedValue({ ...ctx(), snapshot: null });
    await expect(deliverRecipient({ sendId: 'send-1', recipientId: 'r1' })).rejects.toMatchObject({
      name: 'UnrecoverableError',
      message: 'The send has no rendered snapshot',
    });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('is a no-op when the row is not queued or the send is not sending', async () => {
    store.loadDelivery.mockResolvedValue({
      ...ctx(),
      recipient: { ...ctx().recipient, status: 'sent' },
    });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    store.loadDelivery.mockResolvedValue({ ...ctx(), send: { ...ctx().send, outcome: 'failed' } });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('throws unrecoverably when the destination is gone, disabled, or unreadable', async () => {
    mockDestination.mockResolvedValue(null);
    await expect(deliverRecipient({ sendId: 'send-1', recipientId: 'r1' })).rejects.toThrow(
      /destination/
    );
    mockDestination.mockResolvedValue({
      id: 'd1',
      type: 'email',
      enabled: true,
      configStatus: 'ok',
    });
    mockReadConfig.mockReturnValue({ ok: false, reason: 'bad_key' });
    await expect(deliverRecipient({ sendId: 'send-1', recipientId: 'r1' })).rejects.toThrow(
      /destination/
    );
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('rejects when the decrypted config is missing the host or from address', async () => {
    mockReadConfig.mockReturnValue({ ok: true, config: {}, rewrap: false });
    await expect(deliverRecipient({ sendId: 'send-1', recipientId: 'r1' })).rejects.toThrow(
      /missing its host or from address/
    );
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('rewraps a config opened under the secondary key before sending', async () => {
    mockReadConfig.mockReturnValue({ ok: true, config, rewrap: true });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    expect(mockRewrapConfig).toHaveBeenCalledWith('d1', config);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('notes the error and rethrows on a connection failure so the queue retries', async () => {
    mockSendMail.mockRejectedValueOnce(
      Object.assign(new Error('refused'), { code: 'ECONNECTION' })
    );
    await expect(deliverRecipient({ sendId: 'send-1', recipientId: 'r1' })).rejects.toThrow(
      'Could not connect to smtp.example.com:587'
    );
    expect(store.noteRecipientError).toHaveBeenCalledWith(
      'r1',
      'Could not connect to smtp.example.com:587'
    );
    expect(store.markRecipient).not.toHaveBeenCalled();
  });

  it('notes a connect-stage timeout and rethrows because the message never went out', async () => {
    mockSendMail.mockRejectedValueOnce(
      Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' })
    );
    await expect(deliverRecipient({ sendId: 'send-1', recipientId: 'r1' })).rejects.toThrow(
      'Could not connect to smtp.example.com:587'
    );
    expect(store.noteRecipientError).toHaveBeenCalledWith(
      'r1',
      'Could not connect to smtp.example.com:587'
    );
    expect(store.markRecipient).not.toHaveBeenCalled();
  });

  it('settles as unknown when the session times out after the message may have gone out', async () => {
    mockSendMail.mockRejectedValueOnce(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }));
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    const messageId = store.beginAttempt.mock.calls[0]?.[1] as string;
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(store.markRecipient).toHaveBeenCalledWith(
      'r1',
      'unknown',
      expect.stringContaining(messageId)
    );
    expect(store.finalizeSend).toHaveBeenCalledWith('send-1');
    expect(store.noteRecipientError).not.toHaveBeenCalled();
  });

  it('settles as unknown when a live socket drops after the message may have gone out', async () => {
    mockSendMail.mockRejectedValueOnce(
      Object.assign(new Error('read ECONNRESET'), { code: 'ESOCKET' })
    );
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    const messageId = store.beginAttempt.mock.calls[0]?.[1] as string;
    expect(store.markRecipient).toHaveBeenCalledWith(
      'r1',
      'unknown',
      expect.stringContaining(messageId)
    );
    expect(store.finalizeSend).toHaveBeenCalledWith('send-1');
    expect(store.noteRecipientError).not.toHaveBeenCalled();
  });

  it('settles as unknown without resending when a previous attempt never recorded an outcome', async () => {
    store.beginAttempt.mockResolvedValue({
      previousMessageId: '<old@x>',
      previousError: null,
      attempts: 2,
    });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(store.markRecipient).toHaveBeenCalledWith(
      'r1',
      'unknown',
      expect.stringContaining('<old@x>')
    );
    expect(store.finalizeSend).toHaveBeenCalledWith('send-1');
  });

  it('retries normally when the previous attempt failed before the message was accepted', async () => {
    store.beginAttempt.mockResolvedValue({
      previousMessageId: '<old@x>',
      previousError: 'Could not connect to h:1',
      attempts: 2,
    });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('hosted image mode points posters at the external proxy url and skips inline attachments', async () => {
    store.loadDelivery.mockResolvedValue({
      ...ctx(),
      newsletter: { id: 'n1', imageMode: 'hosted' },
    });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    const mail = mockSendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(mail.html)).toContain(
      'src="https://tracearr.example.com/api/v1/images/proxy?server=s1&url=%2Ft&width=360&height=540&fallback=poster&v=v1"'
    );
    expect((mail.attachments as { cid: string }[]).map((a) => a.cid)).toEqual(['logo']);
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it('none image mode drops the poster image and attaches nothing', async () => {
    store.loadDelivery.mockResolvedValue({
      ...ctx(),
      snapshot: {
        ...ctx().snapshot,
        html: '<p>Hi</p><img src="poster:m1" alt="Heat">',
        text: 'Hi',
      },
      newsletter: { id: 'n1', imageMode: 'none' },
    });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    const mail = mockSendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(mail.html)).not.toContain('<img');
    expect(String(mail.html)).not.toContain('poster:');
    expect(mail.attachments).toEqual([]);
    expect(mockProxy).not.toHaveBeenCalled();
  });
});

describe('markRecipientFailed', () => {
  it('records the failure and finalizes the send', async () => {
    await markRecipientFailed('r1', new Error('boom'));
    expect(store.markRecipient).toHaveBeenCalledWith('r1', 'failed', 'boom');
    expect(store.finalizeSend).toHaveBeenCalledWith('send-1');
  });
});
