import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ getSend: vi.fn(), getNewsletter: vi.fn() }));
vi.mock('../store.js', () => store);
const mockDispatch = vi.hoisted(() => vi.fn());
vi.mock('../../automations/events/producers.js', () => ({
  dispatchNewsletterSend: (...a: unknown[]) => mockDispatch(...a) as unknown,
}));
const mockSettings = vi.hoisted(() => vi.fn());
vi.mock('../../settings.js', () => ({ getNetworkSettings: () => mockSettings() as unknown }));

import { announceSendFinished } from '../events.js';

const send = {
  id: 'send-1',
  newsletterId: 'n-1',
  trigger: 'schedule',
  outcome: 'partial',
  recipientCount: 12,
  itemCounts: { movies: 2 },
  error: null,
  windowStart: new Date('2026-08-26T00:00:00Z'),
  windowEnd: new Date('2026-09-02T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  store.getSend.mockResolvedValue(send);
  store.getNewsletter.mockResolvedValue({ id: 'n-1', name: 'Weekly' });
  mockSettings.mockResolvedValue({
    externalUrl: 'https://tracearr.example.com/',
    trustProxy: false,
  });
});

describe('announceSendFinished', () => {
  it('dispatches the send with its history url once per finished send', async () => {
    await announceSendFinished('send-1');
    expect(mockDispatch).toHaveBeenCalledWith({
      newsletterId: 'n-1',
      sendId: 'send-1',
      name: 'Weekly',
      outcome: 'partial',
      trigger: 'schedule',
      recipientCount: 12,
      itemCounts: { movies: 2 },
      error: null,
      windowStart: '2026-08-26T00:00:00.000Z',
      windowEnd: '2026-09-02T00:00:00.000Z',
      historyUrl: 'https://tracearr.example.com/settings/notifications/newsletters/n-1',
    });
  });

  it('has no history url without an external url', async () => {
    mockSettings.mockResolvedValue({ externalUrl: null, trustProxy: false });
    await announceSendFinished('send-1');
    expect(mockDispatch.mock.calls[0]?.[0]).toMatchObject({ historyUrl: null });
  });

  it.each([
    ['a skipped window', { ...send, outcome: 'skipped_empty' }],
    ['a send still sending', { ...send, outcome: 'sending' }],
    ['a test send', { ...send, trigger: 'test', outcome: 'failed' }],
  ])('announces nothing for %s', async (_label, row) => {
    store.getSend.mockResolvedValue(row);
    await announceSendFinished('send-1');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('announces nothing when the send or its newsletter is gone', async () => {
    store.getNewsletter.mockResolvedValue(null);
    await announceSendFinished('send-1');
    store.getSend.mockResolvedValue(null);
    await announceSendFinished('send-1');
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
