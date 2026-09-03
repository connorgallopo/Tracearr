import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  loadDelivery: vi.fn(),
  beginAttempt: vi.fn(),
  markRecipient: vi.fn(),
  noteRecipientError: vi.fn(),
  finalizeSend: vi.fn(),
}));
vi.mock('../store.js', () => store);
const mockSendMail = vi.fn();
const mockGetTransporter = vi.fn((..._args: unknown[]) => ({ sendMail: mockSendMail }));
vi.mock('../../notifications/destinations/emailTransport.js', () => ({
  getTransporter: (...a: unknown[]) => mockGetTransporter(...a) as unknown,
  describeSmtpError: (e: unknown) => (e instanceof Error ? e.message : 'smtp'),
}));
const mockDestination = vi.fn();
const mockReadConfig = vi.fn();
vi.mock('../../notifications/destinationStore.js', () => ({
  getDestination: (...a: unknown[]) => mockDestination(...a) as unknown,
  readConfig: (...a: unknown[]) => mockReadConfig(...a) as unknown,
}));
const mockProxy = vi.fn();
vi.mock('../../imageProxy.js', () => ({
  proxyImage: (...a: unknown[]) => mockProxy(...a) as unknown,
  buildProxyUrl: (o: { serverId: string; path: string; version?: string }) =>
    `/api/v1/images/proxy?server=${o.serverId}&url=${encodeURIComponent(o.path)}&v=${o.version ?? ''}`,
  posterVersionFor: (path: string) => path,
}));
vi.mock('../../notifications/emailLogo.js', () => ({ readLogoPng: () => Buffer.from('png') }));
const mockSettings = vi.fn();
vi.mock('../../settings.js', () => ({ getNetworkSettings: () => mockSettings() as unknown }));
vi.mock('../links.js', () => ({ signUnsubscribeToken: (id: string) => `tok-${id}` }));

import { deliverRecipient, markRecipientFailed } from '../deliver.js';

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
    status: 'queued',
    attempts: 0,
    error: null,
    messageId: null,
    sentAt: null,
  },
  send: {
    id: 'send-1',
    newsletterId: 'n1',
    destinationId: 'd1',
    outcome: 'sending',
    subject: 'x',
    html: '<p>Hi</p><img src="poster:m1" alt="Heat"><a href="{{unsubscribe_url}}">Unsubscribe</a>',
    text: 'Hi\nUnsubscribe [{{unsubscribe_url}}]',
    posters: { m1: { serverId: 's1', thumbPath: '/t', version: 'v1' } },
  },
  newsletter: { id: 'n1', imageMode: 'auto' },
});

beforeEach(() => {
  vi.clearAllMocks();
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
        'List-Unsubscribe': '<https://tracearr.example.com/api/v1/email/unsubscribe/tok-r1>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    expect(String(mail.html)).toContain(
      'href="https://tracearr.example.com/api/v1/email/unsubscribe/tok-r1"'
    );
    expect(String(mail.html)).toContain('src="cid:m1"');
    expect(String(mail.text)).toContain(
      'https://tracearr.example.com/api/v1/email/unsubscribe/tok-r1'
    );
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
  });

  it('sends no unsubscribe headers without an external url', async () => {
    mockSettings.mockResolvedValue({ externalUrl: null, trustProxy: false });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    const mail = mockSendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mail.headers).toBeUndefined();
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

  it('notes the error and rethrows on a connection failure so the queue retries', async () => {
    mockSendMail.mockRejectedValueOnce(
      Object.assign(new Error('refused'), { code: 'ECONNECTION' })
    );
    await expect(deliverRecipient({ sendId: 'send-1', recipientId: 'r1' })).rejects.toThrow(
      'refused'
    );
    expect(store.noteRecipientError).toHaveBeenCalledWith('r1', 'refused');
    expect(store.markRecipient).not.toHaveBeenCalled();
  });

  it('marks unknown without resending when a prior attempt timed out after its message id was written', async () => {
    store.beginAttempt.mockResolvedValue({
      previousMessageId: '<old@example.com>',
      previousError: 'Timeout',
      attempts: 2,
    });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(store.markRecipient).toHaveBeenCalledWith(
      'r1',
      'unknown',
      expect.stringContaining('may have been delivered')
    );
    expect(store.finalizeSend).toHaveBeenCalledWith('send-1');
  });

  it('a prior connection-stage failure retries normally even with a message id on the row', async () => {
    store.beginAttempt.mockResolvedValue({
      previousMessageId: '<old@example.com>',
      previousError: 'refused',
      attempts: 2,
    });
    await deliverRecipient({ sendId: 'send-1', recipientId: 'r1' });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});

describe('markRecipientFailed', () => {
  it('records the failure and finalizes the send', async () => {
    await markRecipientFailed('r1', new Error('boom'));
    expect(store.markRecipient).toHaveBeenCalledWith('r1', 'failed', 'boom');
    expect(store.finalizeSend).toHaveBeenCalledWith('send-1');
  });
});
