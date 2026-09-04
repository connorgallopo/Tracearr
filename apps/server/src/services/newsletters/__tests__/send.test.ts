import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NEWSLETTER_SECTIONS } from '@tracearr/shared';

const store = vi.hoisted(() => ({
  getNewsletter: vi.fn(),
  findOpenSend: vi.fn(),
  closeStaleSend: vi.fn(),
  queuedRecipientIds: vi.fn(),
  lastWatermark: vi.fn(),
  insertSend: vi.fn(),
  insertRecipients: vi.fn(),
  markSendSending: vi.fn(),
  markSendOutcome: vi.fn(),
  loadServerLinks: vi.fn(),
  OpenSendConflict: class OpenSendConflict extends Error {},
}));
vi.mock('../store.js', () => store);
const mockAssemble = vi.fn();
vi.mock('../assemble.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../assemble.js')>();
  return {
    ...actual,
    assembleDigest: (...a: unknown[]) => mockAssemble(...a) as unknown,
  };
});
const mockResolve = vi.fn();
vi.mock('../recipients.js', () => ({
  resolveRecipients: (...a: unknown[]) => mockResolve(...a) as unknown,
}));
vi.mock('../links.js', () => ({ newViewToken: () => 'view-token' }));
const mockSettings = vi.fn();
vi.mock('../../settings.js', () => ({ getNetworkSettings: () => mockSettings() as unknown }));
const mockLogoPng = vi.fn();
vi.mock('../../notifications/emailLogo.js', () => ({
  readLogoPng: () => mockLogoPng() as unknown,
}));
const mockBranding = vi.fn();
vi.mock('../../notifications/emailBranding.js', () => ({
  resolveEmailBranding: (...a: unknown[]) => mockBranding(...a) as unknown,
}));
const mockDestination = vi.fn();
vi.mock('../../notifications/destinationStore.js', () => ({
  getDestination: (...a: unknown[]) => mockDestination(...a) as unknown,
}));

import { runNewsletter } from '../send.js';
import { EMAIL_CLIP_FIT_BYTES, deliveredBytes } from '../fit.js';
import { EXTERNAL_URL, JELLYFIN_SERVER, heaviestDigest, heaviestRuns } from './heaviestDigest.js';

const NEWSLETTER = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Weekly',
  enabled: true,
  destinationId: '22222222-2222-4222-8222-222222222222',
  schedule: { kind: 'weekly', dayOfWeek: 5, time: '18:00' },
  timezone: 'UTC',
  window: { kind: 'since_last_send', fallbackDays: 7 },
  scope: { serverIds: [], libraryIds: [] },
  sections: DEFAULT_NEWSLETTER_SECTIONS,
  subject: "What's new on {{server_name}} ({{end_date}}) {{item_count}}",
  intro: null,
  outro: null,
  recipients: { members: true, extraAddresses: [], excludeUserIds: [] },
  imageMode: 'auto',
  skipWhenEmpty: true,
  senderName: null,
  links: { tracearr: false },
  createdAt: new Date(),
  updatedAt: new Date(),
};
const EMPTY = {
  movies: [],
  shows: [],
  artists: [],
  mostWatched: [],
  counts: { movies: 0, shows: 0, episodes: 0, albums: 0, mostWatched: 0 },
  isEmpty: true,
};
const ONE_MOVIE = {
  ...EMPTY,
  movies: [
    {
      cardId: 'm1',
      serverId: 's1',
      serverName: 'Basement',
      serverType: 'plex',
      ratingKey: '1',
      mediaId: null,
      imdbId: null,
      thumbPath: '/t',
      title: 'Heat',
      year: 1995,
      genres: [],
      addedAt: new Date(),
    },
  ],
  counts: { ...EMPTY.counts, movies: 1 },
  isEmpty: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLogoPng.mockReturnValue(Buffer.from('png'));
  mockBranding.mockResolvedValue({
    branding: { accentColor: '#0ea0b3', footerText: null, postalAddress: null },
    logo: { mode: 'tracearr' },
    mailtoUnsubscribe: false,
  });
  store.getNewsletter.mockResolvedValue(NEWSLETTER);
  store.findOpenSend.mockResolvedValue(null);
  store.closeStaleSend.mockResolvedValue(false);
  store.lastWatermark.mockResolvedValue(new Date('2026-08-26T00:00:00Z'));
  store.insertSend.mockImplementation(async (v: Record<string, unknown>) => ({
    id: 'send-1',
    ...v,
  }));
  store.insertRecipients.mockImplementation(
    async (_s: string, rows: { address: string; status: string }[]) =>
      rows.map((r, i) => ({ id: `r${i}`, ...r }))
  );
  store.loadServerLinks.mockResolvedValue([
    { id: 's1', name: 'Basement', type: 'plex', url: 'http://plex', machineIdentifier: 'abc' },
  ]);
  mockAssemble.mockResolvedValue({
    data: ONE_MOVIE,
    posters: { m1: { serverId: 's1', thumbPath: '/t', version: 'v1' } },
  });
  mockResolve.mockResolvedValue({
    recipients: [
      { address: 'a@x.com', userId: 'u1', name: null, suppressed: false },
      { address: 'gone@x.com', userId: 'u2', name: null, suppressed: true },
    ],
    missing: [{ userId: 'u9', serverUserId: 'su-9', name: null }],
    excluded: [],
  });
  mockSettings.mockResolvedValue({
    externalUrl: 'https://tracearr.example.com',
    trustProxy: false,
  });
  mockDestination.mockResolvedValue({
    id: NEWSLETTER.destinationId,
    type: 'email',
    enabled: true,
    configStatus: 'ok',
  });
});

function firstSend(): { subject?: string; html?: string; text?: string } {
  const [first] = store.insertSend.mock.calls[0] ?? [];
  expect(first).toBeDefined();
  return first as { subject?: string; html?: string; text?: string };
}

async function renderedHtml(): Promise<string> {
  store.insertSend.mockClear();
  await runNewsletter(NEWSLETTER.id, 'schedule');
  return String(firstSend().html);
}

describe('runNewsletter', () => {
  it('renders once, stores the send with placeholders and posters, inserts one row per recipient, and returns the queued ids', async () => {
    const result = await runNewsletter(NEWSLETTER.id, 'schedule');
    expect(result).toEqual({ outcome: 'queued', sendId: 'send-1', queuedRecipientIds: ['r0'] });
    const send = store.insertSend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(send).toMatchObject({
      newsletterId: NEWSLETTER.id,
      destinationId: NEWSLETTER.destinationId,
      viewToken: 'view-token',
      trigger: 'schedule',
      windowStart: new Date('2026-08-26T00:00:00Z'),
      outcome: 'rendering',
      itemCounts: ONE_MOVIE.counts,
      posters: { m1: { serverId: 's1', thumbPath: '/t', version: 'v1' } },
    });
    expect(String(send.subject)).toMatch(/^What's new on Basement \(\w{3} \d{1,2}, \d{4}\) 1$/);
    expect(String(send.html)).toContain('src="poster:m1"');
    expect(String(send.html)).toContain('href="{{unsubscribe_url}}"');
    expect(String(send.html)).toContain('href="{{view_url}}"');
    expect(String(send.text)).toContain('{{unsubscribe_url}}');
    expect(String(send.text)).toContain('{{view_url}}');
    expect(store.insertRecipients).toHaveBeenCalledWith('send-1', [
      { address: 'a@x.com', userId: 'u1', status: 'queued' },
      { address: 'gone@x.com', userId: 'u2', status: 'suppressed' },
    ]);
    expect(store.markSendSending).toHaveBeenCalledWith('send-1', 1);
    expect(mockAssemble).toHaveBeenCalledWith(NEWSLETTER, {
      start: new Date('2026-08-26T00:00:00Z'),
      end: expect.any(Date),
    });
    expect(mockDestination).toHaveBeenCalledWith(NEWSLETTER.destinationId);
    expect(store.lastWatermark).toHaveBeenCalledWith(NEWSLETTER.id);
    expect(mockResolve).toHaveBeenCalledWith(NEWSLETTER);
    expect(store.loadServerLinks).toHaveBeenCalledWith(NEWSLETTER.scope.serverIds);
  });

  it('renders the subject template with the server name, dates and item count', async () => {
    await runNewsletter(NEWSLETTER.id, 'manual');
    expect(String(firstSend().html)).toMatch(
      /What&#x27;s new on Basement \(\w{3} \d{1,2}, \d{4}\) 1/
    );
  });

  it('renders through the branding block with the newsletter sender name in the subject and footer', async () => {
    mockBranding.mockResolvedValue({
      branding: {
        accentColor: '#123456',
        footerText: 'The house server',
        postalAddress: '1 Main St',
      },
      logo: { mode: 'tracearr' },
      mailtoUnsubscribe: false,
    });
    store.getNewsletter.mockResolvedValue({ ...NEWSLETTER, senderName: 'Family Media' });
    await runNewsletter(NEWSLETTER.id, 'schedule');
    expect(mockBranding).toHaveBeenCalledWith();
    const send = firstSend();
    expect(String(send.subject)).toMatch(/^What's new on Family Media \(\w{3} \d{1,2}, \d{4}\) 1$/);
    const html = String(send.html);
    expect(html).toContain('#123456');
    expect(html).toContain('Sent by Tracearr for <!-- -->Family Media');
    expect(html).toContain('The house server');
    expect(html).toContain('1 Main St');
  });

  it('names the sender Tracearr when the scope spans two servers and no name is set', async () => {
    store.loadServerLinks.mockResolvedValue([
      { id: 's1', name: 'Basement', type: 'plex', url: 'http://plex', machineIdentifier: 'abc' },
      { id: 's2', name: 'Attic', type: 'jellyfin', url: 'http://jf', machineIdentifier: null },
    ]);
    await runNewsletter(NEWSLETTER.id, 'schedule');
    expect(String(firstSend().subject)).toMatch(/^What's new on Tracearr /);
  });

  it('emits the Tracearr media link only when the newsletter turns links on', async () => {
    const withMedia = {
      ...ONE_MOVIE,
      movies: [{ ...ONE_MOVIE.movies[0]!, mediaId: 'media-1' }],
    };
    mockAssemble.mockResolvedValue({ data: withMedia, posters: {} });
    expect(await renderedHtml()).not.toContain('https://tracearr.example.com/media/media-1');
    store.getNewsletter.mockResolvedValue({ ...NEWSLETTER, links: { tracearr: true } });
    expect(await renderedHtml()).toContain('href="https://tracearr.example.com/media/media-1"');
  });

  it('points the logo at the hosted route, a cid, or nothing, by image mode', async () => {
    store.getNewsletter.mockResolvedValue({ ...NEWSLETTER, imageMode: 'hosted' });
    expect(await renderedHtml()).toContain('src="https://tracearr.example.com/api/v1/images/logo"');

    store.getNewsletter.mockResolvedValue({ ...NEWSLETTER, imageMode: 'auto' });
    expect(await renderedHtml()).toContain('src="cid:logo"');

    store.getNewsletter.mockResolvedValue({ ...NEWSLETTER, imageMode: 'none' });
    expect(await renderedHtml()).not.toContain('cid:logo');

    store.getNewsletter.mockResolvedValue(NEWSLETTER);
    mockLogoPng.mockReturnValue(null);
    expect(await renderedHtml()).not.toContain('cid:logo');
  });

  it('uses the owner logo url in place of the Tracearr png in either image mode', async () => {
    mockBranding.mockResolvedValue({
      branding: { accentColor: '#0ea0b3', footerText: null, postalAddress: null },
      logo: { mode: 'url', url: 'https://x.test/l.png' },
      mailtoUnsubscribe: false,
    });
    mockLogoPng.mockReturnValue(null);
    store.getNewsletter.mockResolvedValue({ ...NEWSLETTER, imageMode: 'hosted' });
    expect(await renderedHtml()).toContain('src="https://x.test/l.png"');

    store.getNewsletter.mockResolvedValue({ ...NEWSLETTER, imageMode: 'auto' });
    expect(await renderedHtml()).toContain('src="https://x.test/l.png"');
  });

  it('renders a rich intro through the mapper', async () => {
    store.getNewsletter.mockResolvedValue({
      ...NEWSLETTER,
      intro: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Hi all', marks: [{ type: 'bold' }] }],
          },
        ],
      },
    });
    expect(await renderedHtml()).toContain('<strong>Hi all</strong>');
  });

  it('skips an empty window with a recorded send and no recipients', async () => {
    mockAssemble.mockResolvedValue({ data: EMPTY, posters: {} });
    const result = await runNewsletter(NEWSLETTER.id, 'schedule');
    expect(result).toEqual({ outcome: 'skipped_empty', sendId: 'send-1', queuedRecipientIds: [] });
    expect(store.insertSend.mock.calls[0]?.[0]).toMatchObject({
      outcome: 'skipped_empty',
      html: null,
    });
    expect(store.insertRecipients).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('a test send goes to the typed address only, bypasses suppression, and renders the empty state', async () => {
    mockAssemble.mockResolvedValue({ data: EMPTY, posters: {} });
    const result = await runNewsletter(NEWSLETTER.id, 'test', 'Me@Example.com');
    expect(result.outcome).toBe('queued');
    expect(mockResolve).not.toHaveBeenCalled();
    expect(store.insertRecipients).toHaveBeenCalledWith('send-1', [
      { address: 'me@example.com', userId: null, status: 'queued' },
    ]);
    expect(String(firstSend().html)).toContain('Nothing new this period');
  });

  it('fails with a recorded reason when the destination is missing, disabled, or needs re-entry', async () => {
    mockDestination.mockResolvedValue({
      id: 'x',
      type: 'email',
      enabled: false,
      configStatus: 'ok',
    });
    const result = await runNewsletter(NEWSLETTER.id, 'schedule');
    expect(result.outcome).toBe('failed');
    expect(store.insertSend.mock.calls[0]?.[0]).toMatchObject({
      outcome: 'failed',
      error: expect.stringContaining('destination'),
    });
  });

  it('records a failure when nobody is deliverable', async () => {
    mockResolve.mockResolvedValue({
      recipients: [{ address: 'gone@x.com', userId: null, name: null, suppressed: true }],
      missing: [],
      excluded: [],
    });
    const result = await runNewsletter(NEWSLETTER.id, 'schedule');
    expect(result.outcome).toBe('failed');
    expect(store.insertSend.mock.calls[0]?.[0]).toMatchObject({
      outcome: 'failed',
      error: 'No deliverable recipients',
    });
  });

  it('resumes a sending send with its queued ids instead of creating a second one', async () => {
    store.findOpenSend.mockResolvedValue({ id: 'open-1', outcome: 'sending' });
    store.queuedRecipientIds.mockResolvedValue(['r7']);
    const result = await runNewsletter(NEWSLETTER.id, 'schedule');
    expect(result).toEqual({ outcome: 'resumed', sendId: 'open-1', queuedRecipientIds: ['r7'] });
    expect(store.insertSend).not.toHaveBeenCalled();
  });

  it('reports busy for a test send while another send is open', async () => {
    store.findOpenSend.mockResolvedValue({ id: 'open-1', outcome: 'sending' });
    expect(await runNewsletter(NEWSLETTER.id, 'test', 'me@example.com')).toEqual({
      outcome: 'busy',
      sendId: 'open-1',
      queuedRecipientIds: [],
    });
  });

  it('uses the reply line instead of a placeholder when there is no external url', async () => {
    mockSettings.mockResolvedValue({ externalUrl: null, trustProxy: false });
    await runNewsletter(NEWSLETTER.id, 'schedule');
    const html = String(firstSend().html);
    expect(html).toContain('Reply to this email to unsubscribe');
    expect(html).not.toContain('{{unsubscribe_url}}');
    expect(html).not.toContain('{{view_url}}');
    expect(html).not.toContain('View in browser');
  });

  it('records a failed send when assembly throws before any send row exists, and rethrows', async () => {
    mockAssemble.mockRejectedValueOnce(new Error('boom'));
    await expect(runNewsletter(NEWSLETTER.id, 'schedule')).rejects.toThrow('boom');
    expect(store.insertSend).toHaveBeenCalledTimes(1);
    expect(store.insertSend.mock.calls[0]?.[0]).toMatchObject({
      newsletterId: NEWSLETTER.id,
      outcome: 'failed',
      error: 'boom',
      itemCounts: {},
    });
  });

  it('closes the send as failed when it dies after insertSend, and rethrows', async () => {
    store.insertRecipients.mockRejectedValueOnce(new Error('boom'));
    await expect(runNewsletter(NEWSLETTER.id, 'schedule')).rejects.toThrow('boom');
    expect(store.markSendOutcome).toHaveBeenCalledWith('send-1', 'failed', 'boom');
  });

  it('closes a stale open send and lets the run continue', async () => {
    const stale = {
      id: 'open-1',
      outcome: 'rendering',
      startedAt: new Date(Date.now() - 11 * 60_000),
    };
    store.findOpenSend.mockResolvedValueOnce(stale);
    store.closeStaleSend.mockResolvedValueOnce(true);
    const result = await runNewsletter(NEWSLETTER.id, 'schedule');
    expect(store.closeStaleSend).toHaveBeenCalledWith(stale);
    expect(store.insertSend).toHaveBeenCalled();
    expect(result.outcome).toBe('queued');
  });

  it('answers busy without ids for a rendering send that has not gone stale yet', async () => {
    store.findOpenSend.mockResolvedValue({
      id: 'open-1',
      outcome: 'rendering',
      startedAt: new Date(Date.now() - 60_000),
    });
    const result = await runNewsletter(NEWSLETTER.id, 'schedule');
    expect(result).toEqual({ outcome: 'busy', sendId: 'open-1', queuedRecipientIds: [] });
    expect(store.queuedRecipientIds).not.toHaveBeenCalled();
    expect(store.markSendOutcome).not.toHaveBeenCalled();
    expect(store.insertSend).not.toHaveBeenCalled();
  });

  it('resumes the other send when insertSend loses an open-send race', async () => {
    store.findOpenSend
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'open-1', outcome: 'sending', startedAt: new Date() });
    store.insertSend.mockRejectedValueOnce(new store.OpenSendConflict('n1'));
    store.queuedRecipientIds.mockResolvedValue(['r9']);
    const result = await runNewsletter(NEWSLETTER.id, 'schedule');
    expect(result).toEqual({ outcome: 'resumed', sendId: 'open-1', queuedRecipientIds: ['r9'] });
  });

  it('stores the trimmed render as the snapshot when the digest would be clipped', async () => {
    const { data, posters } = heaviestDigest();
    mockAssemble.mockResolvedValue({ data, posters });
    mockSettings.mockResolvedValue({ externalUrl: EXTERNAL_URL, trustProxy: false });
    store.loadServerLinks.mockResolvedValue([JELLYFIN_SERVER]);
    store.getNewsletter.mockResolvedValue({
      ...NEWSLETTER,
      scope: { serverIds: [JELLYFIN_SERVER.id], libraryIds: [] },
      imageMode: 'hosted',
      links: { tracearr: true },
      intro: heaviestRuns(),
      outro: heaviestRuns(),
    });
    mockBranding.mockResolvedValue({
      branding: {
        accentColor: '#0ea0b3',
        footerText: 'f'.repeat(500),
        postalAddress: 'p'.repeat(500),
      },
      logo: { mode: 'tracearr' },
      mailtoUnsubscribe: false,
    });
    const result = await runNewsletter(NEWSLETTER.id, 'schedule');
    expect(result.outcome).toBe('queued');
    const send = store.insertSend.mock.calls[0]?.[0] as {
      html: string;
      itemCounts: unknown;
      posters: unknown;
    };
    expect(send.html).toContain('+9 more shows');
    expect(send.html).toContain('src="poster:');
    expect(deliveredBytes(send.html, posters, 'hosted', EXTERNAL_URL)).toBeLessThanOrEqual(
      EMAIL_CLIP_FIT_BYTES
    );
    expect(send.itemCounts).toEqual(data.counts);
    expect(send.posters).toBe(posters);
  });
});
