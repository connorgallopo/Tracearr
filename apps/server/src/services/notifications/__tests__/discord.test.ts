import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViolationWithDetails } from '@tracearr/shared';

const mockProxyImage = vi.fn();
vi.mock('../../imageProxy.js', () => ({
  proxyImage: (...args: unknown[]) => mockProxyImage(...args) as unknown,
}));

const mockBuildMediaLinks = vi.fn();
vi.mock('../mediaLinks.js', () => ({
  buildMediaLinks: (...args: unknown[]) => mockBuildMediaLinks(...args) as unknown,
}));

import { createMockActiveSession } from '../../../test/fixtures.js';
import { discordType, fitEmbed, type DiscordEmbed } from '../destinations/discord.js';
import type { NotificationEvent } from '../events.js';
import type { RenderContext } from '../destinations/types.js';

mockProxyImage.mockResolvedValue({ data: Buffer.alloc(0), contentType: 'image/svg+xml' });
mockBuildMediaLinks.mockResolvedValue([]);

const config = { webhookUrl: 'https://discord.com/api/webhooks/123/abc' };
const destination = { id: 'dest-1', name: 'My Discord' };
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
};

const session = createMockActiveSession({ durationMs: 3_725_000 });

const fieldNames = (embed: DiscordEmbed): string[] => (embed.fields ?? []).map((f) => f.name);

const render = async (
  event: Parameters<typeof discordType.render>[0],
  ctx: RenderContext = systemCtx
): Promise<DiscordEmbed> => (await discordType.render(event, config, ctx)).embed;

const mediaUpgraded: NotificationEvent = {
  type: 'media_upgraded',
  payload: {
    serverId: 'server-1',
    serverName: 'Basement',
    serverType: 'plex',
    libraryItemId: 'item-1',
    ratingKey: 'rk-1',
    mediaId: null,
    parentTitle: null,
    grandparentRatingKey: null,
    parentRatingKey: null,
    parentIndex: null,
    itemIndex: null,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    thumbPath: null,
    title: 'Cars',
    grandparentTitle: null,
    mediaType: 'movie',
    year: 2006,
    libraryName: 'Movies',
    to: {
      resolution: '4k',
      dynamicRange: 'hdr10',
      videoCodec: 'HEVC',
      audioCodec: 'TRUEHD',
      audioChannels: 8,
      fileSize: 42_000_000_000,
    },
    from: {
      resolution: '1080p',
      dynamicRange: 'sdr',
      videoCodec: 'H264',
      audioCodec: 'AC3',
      audioChannels: 6,
      fileSize: 8_000_000_000,
    },
    changed: ['resolution'],
  },
};

describe('discordType.render', () => {
  it('builds the violation embed with severity color and rule fields', async () => {
    const embed = await render({ type: 'violation', payload: violation });

    expect(embed.title).toBe('Violation Detected');
    expect(embed.color).toBe(0xf39c12);
    expect(fieldNames(embed)).toEqual(['User', 'Rule', 'Severity']);
    expect(embed.fields?.[0]).toEqual({ name: 'User', value: 'Test User', inline: true });
    expect(embed.fields?.[1]).toEqual({ name: 'Rule', value: 'Test Rule', inline: true });
  });

  it('builds the stream started embed', async () => {
    const embed = await render({ type: 'session_started', payload: session });

    expect(embed.title).toBe('Stream Started');
    expect(embed.color).toBe(0x3498db);
    expect(fieldNames(embed)).toEqual([
      'User',
      'Media',
      'Episode',
      'Playback',
      'Location',
      'Player',
    ]);
    expect(embed.fields?.[3]?.value).toBe('Direct Play');
    expect(embed.fields?.[4]?.value).toBe('New York, US');
  });

  it('marks a placed local session in the Location field', async () => {
    const local = createMockActiveSession({ isLocal: true, geoCity: 'Chicago', geoCountry: 'US' });
    const embed = await render({ type: 'session_started', payload: local });
    expect(embed.fields?.find((f) => f.name === 'Location')?.value).toBe(
      'Chicago, US (Local Network)'
    );
  });

  it('shows the country alone when the placed location has no city', async () => {
    const local = createMockActiveSession({ isLocal: true, geoCity: null, geoCountry: 'US' });
    const embed = await render({ type: 'session_started', payload: local });
    expect(embed.fields?.find((f) => f.name === 'Location')?.value).toBe('US (Local Network)');
  });

  it('still omits Location for an unplaced local session', async () => {
    const local = createMockActiveSession({
      isLocal: true,
      geoCity: null,
      geoCountry: 'Local Network',
    });
    const embed = await render({ type: 'session_started', payload: local });
    expect(fieldNames(embed)).not.toContain('Location');
  });

  it('omits Location for a local session with no country', async () => {
    const local = createMockActiveSession({ isLocal: true, geoCity: null, geoCountry: null });
    const embed = await render({ type: 'session_started', payload: local });
    expect(fieldNames(embed)).not.toContain('Location');
  });

  it('builds the stream stopped embed with a formatted duration', async () => {
    const embed = await render({ type: 'session_stopped', payload: session });

    expect(embed.title).toBe('Stream Ended');
    expect(embed.color).toBe(0x95a5a6);
    expect(fieldNames(embed)).toEqual(['User', 'Media', 'Episode', 'Duration']);
    expect(embed.fields?.[3]?.value).toBe('1h 2m');
  });

  const avatar = 'https://plex.tv/users/abc123/avatar?c=1700000000';
  const withAvatar = (thumbUrl: string | null) =>
    createMockActiveSession({
      durationMs: 60_000,
      user: { id: 'su-1', username: 'testuser', thumbUrl, identityName: 'Test User' },
    });

  it.each(['session_started', 'session_stopped'] as const)(
    'names the viewer with their picture on %s',
    async (type) => {
      const embed = await render({ type, payload: withAvatar(avatar) });

      expect(embed.author).toEqual({ name: 'Test User', icon_url: avatar });
      expect(embed.fields?.[0]).toEqual({ name: 'User', value: 'Test User', inline: true });
    }
  );

  it('names the viewer with their picture on a violation', async () => {
    const embed = await render({
      type: 'violation',
      payload: { ...violation, user: { ...violation.user, thumbUrl: avatar } },
    });

    expect(embed.author).toEqual({ name: 'Test User', icon_url: avatar });
  });

  it.each([
    [null],
    ['/Users/abc/Images/Primary'],
    ['http://plex.tv/users/abc/avatar'],
    ['https://192.168.1.10:32400/photo/:/transcode?url=/x'],
    ['https://plex.local:32400/library/metadata/1/thumb'],
    ['https://media/users/abc/avatar'],
    ['https://[::1]/avatar'],
    ['https://plex.example.com/photo?X-Plex-Token=secret'],
    ['https://jellyfin.example.com/Users/abc/Images/Primary?api_key=secret'],
    ['https://user:pass@plex.tv/users/abc/avatar'],
  ])('leaves the author off when the picture is %s', async (thumbUrl) => {
    const started = await render({ type: 'session_started', payload: withAvatar(thumbUrl) });
    const flagged = await render({
      type: 'violation',
      payload: { ...violation, user: { ...violation.user, thumbUrl } },
    });

    expect(started.author).toBeUndefined();
    expect(flagged.author).toBeUndefined();
    expect(JSON.stringify([started, flagged])).not.toMatch(/secret|192\.168|plex\.local/);
  });

  it('builds the server down embed', async () => {
    const embed = await render({
      type: 'server_down',
      payload: { serverName: 'Plex Server', serverId: 's1' },
    });

    expect(embed).toEqual({
      title: 'Server Connection Lost',
      description: 'Lost connection to Plex Server',
      color: 0xff0000,
    });
  });

  it('builds the server up embed', async () => {
    const embed = await render({
      type: 'server_up',
      payload: { serverName: 'Plex Server', serverId: 's1' },
    });

    expect(embed).toEqual({
      title: 'Server Back Online',
      description: 'Plex Server is back online',
      color: 0x2ecc71,
    });
  });

  it('builds the plugin update embed', async () => {
    const embed = await render({
      type: 'plugin_update_available',
      payload: {
        serverId: 'server-1',
        serverName: 'Jellyfin',
        serverType: 'jellyfin',
        installedVersion: '0.2.0',
        latestVersion: '0.3.0',
        downloadUrl: 'https://example.com/plugin.zip',
      },
    });

    expect(embed.title).toBe('Plugin Update Available');
    expect(embed.color).toBe(0xf39c12);
    expect(embed.description).toContain('Jellyfin: ');
    expect(embed.description).toContain('latest 0.3.0');
  });
});

describe('discordType.deliver', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('posts the embed as a Tracearr webhook message', async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);

    await discordType.deliver(
      { embed: { title: 'Stream Started', color: 0x3498db } },
      config,
      deliverCtx
    );

    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe(config.webhookUrl);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body);
    expect(body.username).toBe('Tracearr');
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0]).toMatchObject({ title: 'Stream Started', color: 0x3498db });
    expect(typeof body.embeds[0].timestamp).toBe('string');
  });

  it('posts under DISCORD_USERNAME and DISCORD_AVATAR_URL when they are set', async () => {
    vi.stubEnv('DISCORD_USERNAME', ' Statler & Waldorf ');
    vi.stubEnv('DISCORD_AVATAR_URL', 'https://system.example.com/avatars/statler-waldorf.png');
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);

    await discordType.deliver({ embed: { title: 'Stream Started', color: 1 } }, config, deliverCtx);

    const body = JSON.parse(f.mock.calls[0]?.[1].body);
    expect(body.username).toBe('Statler & Waldorf');
    expect(body.avatar_url).toBe('https://system.example.com/avatars/statler-waldorf.png');
  });

  it.each([
    ['http://system.example.com/a.png'],
    ['https://user:pass@system.example.com/a.png'],
    ['not a url'],
    ['/avatars/a.png'],
  ])('keeps the Tracearr picture when DISCORD_AVATAR_URL is %s', async (avatar) => {
    vi.stubEnv('DISCORD_AVATAR_URL', avatar);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);

    await discordType.deliver({ embed: { title: 'Stream Started', color: 1 } }, config, deliverCtx);

    const body = JSON.parse(f.mock.calls[0]?.[1].body);
    expect(body.username).toBe('Tracearr');
    expect(body.avatar_url).toContain('raw.githubusercontent.com');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DISCORD_AVATAR_URL'));
  });

  it('cuts DISCORD_USERNAME to the 80 characters Discord accepts', async () => {
    vi.stubEnv('DISCORD_USERNAME', 'x'.repeat(100));
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);

    await discordType.test(config, deliverCtx);

    expect(JSON.parse(f.mock.calls[0]?.[1].body).username).toBe('x'.repeat(80));
  });

  it('throws when Discord rejects the webhook', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad payload', { status: 400 })));

    await expect(
      discordType.deliver(
        { embed: { title: 'Stream Started', color: 0x3498db } },
        config,
        deliverCtx
      )
    ).rejects.toThrow(/400 bad payload/);
  });

  it('posts the test embed', async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);

    await discordType.test(config, deliverCtx);

    const body = JSON.parse(f.mock.calls[0]?.[1].body);
    expect(body.embeds[0].title).toBe('Test Notification');
    expect(body.embeds[0].description).toBe('This is a test notification from Tracearr');
    expect(body.embeds[0].color).toBe(0x3498db);
  });
});

const newDevice = {
  type: 'new_device',
  payload: {
    serverId: 'server-1',
    serverName: 'Basement',
    serverType: 'plex',
    serverUserId: 'su-1',
    sessionId: 'sess-1',
    userName: 'Test User',
    username: 'testuser',
    identityName: 'Test User',
    mediaTitle: 'Cars',
    mediaType: 'movie',
    deviceName: 'Living Room TV',
    platform: 'tvOS',
    product: 'Plex for Apple TV',
    location: 'Boston, Massachusetts',
  },
} as const;

const trustChanged = {
  type: 'trust_score_changed',
  payload: {
    serverId: 'server-1',
    serverName: 'Basement',
    serverType: 'plex',
    serverUserId: 'su-1',
    userName: 'Test User',
    username: 'testuser',
    identityName: 'Test User',
    previousScore: 90,
    newScore: 40,
    reason: 'Sharing penalty',
  },
} as const;

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

const automationCtx = (over: { title?: string; body?: string } = {}): RenderContext => ({
  destination,
  source: { kind: 'automation', automationId: 'a-1', automationName: 'Now playing', ...over },
});

describe('discordType.render with an automation source', () => {
  it('keeps the builtin stream title when nothing is overridden', async () => {
    const embed = await render({ type: 'session_started', payload: session }, automationCtx());

    expect(embed.title).toBe('Stream Started');
    expect(embed.description).toBeUndefined();
  });

  it('uses the rendered override for the title and the description', async () => {
    const embed = await render(
      { type: 'session_started', payload: session },
      automationCtx({ title: 'Heads up', body: '{{user.username}} pressed play' })
    );

    expect(embed.title).toBe('Heads up');
    expect(embed.description).toBe('testuser pressed play');
  });

  it('gives a new device and a trust move their own colours', async () => {
    const device = await render(newDevice, automationCtx());
    expect(device.title).toBe('New device');
    expect(device.description).toBe(
      'Test User connected from a new device: Living Room TV from Boston, Massachusetts'
    );
    expect(device.color).toBe(0xf39c12);

    const trust = await render(trustChanged, automationCtx());
    expect(trust.description).toBe(
      "Test User's trust score dropped from 90 to 40: Sharing penalty"
    );
    expect(trust.color).toBe(0x9b59b6);

    // Both media events stay in the teal family, apart from the trust purple above.
    expect((await render(mediaUpgraded, automationCtx())).color).toBe(0x16a085);
  });

  it('titles a media upgrade with the item and breaks out every field that moved', async () => {
    const embed = await render(mediaUpgraded, automationCtx());

    expect(embed.title).toBe('Cars');
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        { name: 'Resolution', value: '1080p → 4K', inline: true },
        { name: 'Library', value: 'Movies', inline: true },
        { name: 'Server', value: 'Basement', inline: true },
        { name: 'Year', value: '2006', inline: true },
      ])
    );

    const overridden = await render(mediaUpgraded, automationCtx({ title: 'Better copy' }));
    expect(overridden.title).toBe('Better copy');
  });

  it('builds the tracearr update embed', async () => {
    const embed = await render({
      type: 'tracearr_update_available',
      payload: { current: '2.0.0', latest: '2.1.0', releaseUrl: 'https://example.com/r' },
    });

    expect(embed.title).toBe('Tracearr Update Available');
    expect(embed.description).toContain('2.1.0');
  });

  it('colors a newsletter embed by outcome', async () => {
    const partial = await render(newsletterSend, automationCtx());
    expect(partial).toMatchObject({
      title: 'Newsletter partly sent',
      description: 'Weekly reached only part of its 42 recipients',
      color: 0xe74c3c,
    });

    const sent = await render(
      { ...newsletterSend, payload: { ...newsletterSend.payload, outcome: 'sent' } },
      automationCtx()
    );
    expect(sent.color).toBe(0x2ecc71);
  });
});

describe('discordType media embeds', () => {
  const seasonPayload = {
    serverId: 'server-1',
    serverName: 'Guardian',
    serverType: 'plex',
    libraryItemId: 'item-1',
    ratingKey: 'rk-1',
    mediaId: 'media-1',
    title: 'Season 1',
    grandparentTitle: null,
    parentTitle: 'Murderbot',
    grandparentRatingKey: null,
    parentRatingKey: 'show-rk',
    parentIndex: 1,
    itemIndex: null,
    mediaType: 'season',
    year: 2025,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    thumbPath: '/library/metadata/1/thumb',
    libraryName: 'TV Shows',
    to: {
      resolution: '4k',
      dynamicRange: 'hdr10',
      videoCodec: 'HEVC',
      audioCodec: 'TRUEHD',
      audioChannels: 8,
      fileSize: 42_000_000_000,
    },
    addedEpisodeCount: 10,
  } as const;

  const seasonAdded: NotificationEvent = {
    type: 'media_added',
    payload: { ...seasonPayload },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    mockProxyImage.mockResolvedValue({ data: Buffer.alloc(0), contentType: 'image/svg+xml' });
    mockBuildMediaLinks.mockResolvedValue([]);
  });

  it('titles a season with its show and counts the episodes that came with it', async () => {
    const { embed } = await discordType.render(seasonAdded, config, systemCtx);

    expect(embed.author).toEqual({ name: 'New media added' });
    expect(embed.title).toBe('Murderbot — Season 1');
    expect(embed.description).toBe('10 episodes added');
    expect(embed.fields).toEqual([
      { name: 'Library', value: 'TV Shows', inline: true },
      { name: 'Server', value: 'Guardian', inline: true },
      { name: 'Year', value: '2025', inline: true },
    ]);
  });

  it('renders every link it was given, and titles the embed with the first', async () => {
    mockBuildMediaLinks.mockResolvedValue([
      { label: 'Tracearr', url: 'https://tracearr.example/media/media-1' },
      { label: 'IMDb', url: 'https://www.imdb.com/title/tt1/' },
    ]);

    const { embed } = await discordType.render(seasonAdded, config, systemCtx);

    expect(embed.url).toBe('https://tracearr.example/media/media-1');
    expect(embed.fields?.at(-1)).toEqual({
      name: 'View details',
      value:
        '[Tracearr](https://tracearr.example/media/media-1)  ·  [IMDb](https://www.imdb.com/title/tt1/)',
      inline: false,
    });
  });

  it('uploads the poster and points the thumbnail at it, naming the file for its bytes', async () => {
    mockProxyImage.mockResolvedValue({ data: Buffer.from('webpbytes'), contentType: 'image/webp' });
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);

    const message = await discordType.render(seasonAdded, config, systemCtx);
    expect(message.embed.thumbnail).toEqual({ url: 'attachment://poster.webp' });

    await discordType.deliver(message, config, deliverCtx);

    const [, init] = f.mock.calls[0] ?? [];
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    // Left unset on purpose: undici writes the multipart boundary itself.
    expect(init.headers).not.toHaveProperty('Content-Type');
    const payload = JSON.parse(form.get('payload_json') as string);
    expect(payload.attachments).toEqual([{ id: 0, filename: 'poster.webp' }]);
    expect(payload.avatar_url).toContain('raw.githubusercontent.com');
    expect(form.get('files[0]')).toBeInstanceOf(Blob);
  });

  it('sends json with no attachment when the poster could not be fetched', async () => {
    mockProxyImage.mockRejectedValue(new Error('server unreachable'));
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);

    const message = await discordType.render(seasonAdded, config, systemCtx);
    expect(message.poster).toBeUndefined();
    expect(message.embed.thumbnail).toBeUndefined();

    await discordType.deliver(message, config, deliverCtx);
    const [, init] = f.mock.calls[0] ?? [];
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body).attachments).toBeUndefined();
  });

  it('refuses the placeholder an unreachable server yields, rather than uploading an svg', async () => {
    mockProxyImage.mockResolvedValue({
      data: Buffer.from('<svg/>'),
      contentType: 'image/svg+xml',
    });

    const message = await discordType.render(seasonAdded, config, systemCtx);

    expect(message.poster).toBeUndefined();
  });

  it('asks for no poster at all when the item has no thumb', async () => {
    await discordType.render(
      { type: 'media_added', payload: { ...seasonPayload, thumbPath: null } },
      config,
      systemCtx
    );

    expect(mockProxyImage).not.toHaveBeenCalled();
  });
});

describe('discordType stream posters', () => {
  afterEach(() => {
    mockProxyImage.mockResolvedValue({ data: Buffer.alloc(0), contentType: 'image/svg+xml' });
  });

  // How the poller stores a Live TV episode from an XMLTV guide: no picture of its own and
  // no channel logo, so its thumb is the show's poster, an outside URL.
  const showPoster = 'https://guide.example.com/media/artwork/abc-poster.jpg?v=1';
  const live = createMockActiveSession({
    serverId: 'server-1',
    mediaType: 'live',
    mediaTitle: 'Goats, Snakes, and Dogs',
    grandparentTitle: 'Animal Control',
    thumbPath: showPoster,
    channelThumb: null,
  });

  it.each(['session_started', 'session_stopped'] as const)(
    'attaches the show poster a Live TV episode falls back to on %s',
    async (type) => {
      mockProxyImage.mockResolvedValue({ data: Buffer.from('jpeg'), contentType: 'image/jpeg' });

      const message = await discordType.render({ type, payload: live }, config, systemCtx);

      expect(mockProxyImage).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: 'server-1', imagePath: showPoster })
      );
      expect(message.embed.thumbnail).toEqual({ url: 'attachment://poster.jpg' });
      expect(message.poster?.contentType).toBe('image/jpeg');
    }
  );

  it('attaches the poster of any other stream too', async () => {
    mockProxyImage.mockResolvedValue({ data: Buffer.from('png'), contentType: 'image/png' });

    const message = await discordType.render(
      { type: 'session_started', payload: createMockActiveSession({ serverId: 'server-1' }) },
      config,
      systemCtx
    );

    expect(mockProxyImage).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'server-1', imagePath: '/library/metadata/123/thumb' })
    );
    expect(message.embed.thumbnail).toEqual({ url: 'attachment://poster.png' });
  });

  it('sends the stream without a picture when the image proxy refuses the poster', async () => {
    mockProxyImage.mockRejectedValue(
      new Error('Image URL origin is not in EXTERNAL_IMAGE_ORIGINS')
    );

    const message = await discordType.render(
      { type: 'session_started', payload: live },
      config,
      systemCtx
    );

    expect(message.poster).toBeUndefined();
    expect(message.embed.thumbnail).toBeUndefined();
    expect(message.embed.title).toBe('Stream Started');
  });

  it('asks for no poster when the stream has no thumb', async () => {
    await discordType.render(
      { type: 'session_stopped', payload: { ...createMockActiveSession(), thumbPath: null } },
      config,
      systemCtx
    );

    expect(mockProxyImage).not.toHaveBeenCalled();
  });
});

describe('discord text handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const userNamed = (username: string) => ({
    id: 'su-1',
    username,
    thumbUrl: null,
    identityName: null,
  });

  it('escapes inserted values but not the template text', async () => {
    const embed = await render(
      {
        type: 'session_started',
        payload: createMockActiveSession({
          mediaTitle: 'a_b (2024) - x',
          user: userNamed('bob*_'),
        }),
      },
      automationCtx({ body: '**{{ user.username }}** said {{ session.mediaTitle }}' })
    );
    expect(embed.description).toBe('**bob\\*\\_** said a\\_b \\(2024\\) \\- x');
  });

  it('leaves a url inside an inserted value alone and escapes the text around it', async () => {
    const embed = await render(
      {
        type: 'session_started',
        payload: createMockActiveSession({ mediaTitle: 'a_b https://x.test/a_b(1) c-d' }),
      },
      automationCtx({ body: '{{ session.mediaTitle }}' })
    );
    expect(embed.description).toBe('a\\_b https://x.test/a_b(1) c\\-d');
  });

  it('omits a blank description on every embed', () => {
    expect(fitEmbed({ title: 'Server Back Online', description: '', color: 1 })).toEqual({
      title: 'Server Back Online',
      color: 1,
    });
  });

  it('cuts title and description to their limits', () => {
    const embed = fitEmbed({ title: 't'.repeat(300), description: 'd'.repeat(5000), color: 1 });
    expect([...embed.title]).toHaveLength(256);
    expect([...(embed.description ?? '')]).toHaveLength(4096);
  });

  it('keeps the whole embed within 6000 characters by cutting the description', () => {
    const fields = Array.from({ length: 5 }, (_, i) => ({
      name: `f${i}`,
      value: 'v'.repeat(1000),
      inline: false,
    }));
    const embed = fitEmbed({
      title: 'Title',
      description: 'd'.repeat(4000),
      color: 1,
      fields,
      footer: { text: 'Tracearr' },
    });
    const total =
      embed.title.length +
      (embed.description?.length ?? 0) +
      (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0) +
      (embed.footer?.text.length ?? 0) +
      (embed.author?.name.length ?? 0);
    expect(total).toBeLessThanOrEqual(6000);
  });

  it('turns mentions off on every post', async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);
    await discordType.deliver({ embed: { title: 'x', color: 1 } }, config, deliverCtx);
    const body = JSON.parse(f.mock.calls[0]?.[1].body);
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });
});
