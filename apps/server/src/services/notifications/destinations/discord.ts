import {
  DESTINATION_TEXT_PROFILES,
  DESTINATION_TYPES,
  escapeFor,
  fitText,
  isPlacedLocal,
  LOCAL_NETWORK_COUNTRY,
  POSTER_IMAGE_SIZE,
} from '@tracearr/shared';
import { proxyImage } from '../../imageProxy.js';
import { mediaHeadline, mediaSubtitle, qualityMoves } from '../formatters/media.js';
import { formatPluginUpdateMessage } from '../formatters/pluginUpdate.js';
import { formatServerUpdateMessage, formatTracearrUpdateMessage } from '../formatters/updates.js';
import {
  formatViolationDetailsForDiscord,
  getSeverityInfo,
  type DiscordField,
} from '../formatters/violation.js';
import { buildMediaLinks } from '../mediaLinks.js';
import { toNotificationPayload } from '../types.js';
import { deliverFetch } from './fetch.js';
import { ownText, textOf } from './overrides.js';
import {
  formatDuration,
  getMediaDisplay,
  getPlaybackType,
  getUserDisplayName,
} from './sessionText.js';
import type {
  MediaAddedContext,
  MediaUpgradedContext,
  NotificationPayload,
  PluginUpdateContext,
  ServerContext,
  ServerUpdateContext,
  SessionContext,
  TracearrUpdateContext,
  ViolationContext,
} from '../types.js';
import type { DeliverContext, DestinationType } from './types.js';

const PROFILE = DESTINATION_TEXT_PROFILES.discord;
const EMBED_TOTAL = 6000;

export interface DiscordConfig {
  webhookUrl: string;
}

/**
 * Discord will not fetch an image from the user's own network, and most installs are not
 * reachable from the internet, so a poster travels as an upload the embed points at.
 * The avatar cannot: `avatar_url` rejects the attachment scheme, so it names a public
 * asset in the Tracearr repo, which reveals nothing about the install.
 */
const AVATAR_URL =
  'https://raw.githubusercontent.com/connorgallopo/Tracearr/main/apps/web/public/web-app-manifest-192x192-transparent.png';
const USERNAME = 'Tracearr';
/** Discord refuses a webhook username longer than this. */
const USERNAME_MAX = 80;

/**
 * The name and picture the messages are posted under: DISCORD_USERNAME and
 * DISCORD_AVATAR_URL, else Tracearr's own. The picture must be a public https URL
 * Discord can fetch, with no credentials; anything else is ignored with a warning.
 */
export function discordSender(): { username: string; avatarUrl: string } {
  const name = (process.env.DISCORD_USERNAME ?? '').trim();
  return {
    username: name ? [...name].slice(0, USERNAME_MAX).join('') : USERNAME,
    avatarUrl: senderAvatar(),
  };
}

// The refused DISCORD_AVATAR_URL last warned about, so a bad value warns once, not per message.
let warnedAvatar: string | null = null;

function senderAvatar(): string {
  const avatar = (process.env.DISCORD_AVATAR_URL ?? '').trim();
  if (!avatar) return AVATAR_URL;
  if (isPublicHttpsUrl(avatar)) return avatar;
  if (warnedAvatar !== avatar) {
    warnedAvatar = avatar;
    console.warn(
      '[Discord] Ignoring DISCORD_AVATAR_URL: it is not an https URL without credentials'
    );
  }
  return AVATAR_URL;
}

/** An https URL with a host and no credentials: something Discord itself can fetch. */
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password;
}

/** Discord picks the renderer off the extension, so the name has to match the bytes. */
const POSTER_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function posterFilename(contentType: string): string {
  const base = contentType.split(';')[0]?.trim() ?? '';
  return `poster.${POSTER_EXTENSIONS[base] ?? 'jpg'}`;
}

export interface DiscordEmbed {
  title: string;
  description?: string;
  url?: string;
  color: number;
  author?: { name: string };
  fields?: DiscordField[];
  thumbnail?: { url: string };
  footer?: { text: string };
  timestamp?: string;
}

/** The embed, plus the poster bytes it references when one was available. */
export interface DiscordMessage {
  embed: DiscordEmbed;
  poster?: { data: Buffer; contentType: string };
}

function buildViolationEmbed(payload: NotificationPayload, ctx: ViolationContext): DiscordEmbed {
  const { violation } = ctx;
  const { label: severityLabel, color } = getSeverityInfo(violation.severity);
  const detailFields = formatViolationDetailsForDiscord(
    violation.rule.type,
    violation.data,
    violation.userNames
  );

  const text = textOf(payload, { title: payload.title, message: '' });

  return {
    title: text.title,
    ...(text.message && { description: text.message }),
    color,
    fields: [
      {
        name: 'User',
        value: violation.user.identityName ?? violation.user.username,
        inline: true,
      },
      {
        name: 'Rule',
        value: violation.rule.name,
        inline: true,
      },
      {
        name: 'Severity',
        value: severityLabel,
        inline: true,
      },
      ...detailFields,
    ],
  };
}

function buildSessionStartedEmbed(payload: NotificationPayload, ctx: SessionContext): DiscordEmbed {
  const { session } = ctx;
  const { title: mediaTitle, subtitle } = getMediaDisplay(session);
  const playbackType = getPlaybackType(session);

  const fields: DiscordField[] = [
    {
      name: 'User',
      value: getUserDisplayName(session),
      inline: true,
    },
    {
      name: 'Media',
      value: mediaTitle,
      inline: true,
    },
  ];

  if (subtitle) {
    fields.push({ name: 'Episode', value: subtitle, inline: true });
  }

  fields.push({ name: 'Playback', value: playbackType, inline: true });

  const location = isPlacedLocal({ isLocal: session.isLocal, country: session.geoCountry })
    ? `${[session.geoCity, session.geoCountry].filter(Boolean).join(', ')} (${LOCAL_NETWORK_COUNTRY})`
    : session.geoCity && session.geoCountry
      ? `${session.geoCity}, ${session.geoCountry}`
      : null;
  if (location) {
    fields.push({ name: 'Location', value: location, inline: true });
  }

  fields.push({
    name: 'Player',
    value: session.product || session.playerName || 'Unknown',
    inline: true,
  });

  const text = textOf(payload, { title: 'Stream Started', message: '' });

  return {
    title: text.title,
    ...(text.message && { description: text.message }),
    color: 0x3498db, // Blue
    fields,
  };
}

function buildSessionStoppedEmbed(payload: NotificationPayload, ctx: SessionContext): DiscordEmbed {
  const { session } = ctx;
  const { title: mediaTitle, subtitle } = getMediaDisplay(session);
  const durationStr = session.durationMs ? formatDuration(session.durationMs) : 'Unknown';

  const fields: DiscordField[] = [
    {
      name: 'User',
      value: getUserDisplayName(session),
      inline: true,
    },
    {
      name: 'Media',
      value: mediaTitle,
      inline: true,
    },
  ];

  if (subtitle) {
    fields.push({ name: 'Episode', value: subtitle, inline: true });
  }

  fields.push({ name: 'Duration', value: durationStr, inline: true });

  const text = textOf(payload, { title: 'Stream Ended', message: '' });

  return {
    title: text.title,
    ...(text.message && { description: text.message }),
    color: 0x95a5a6, // Gray
    fields,
  };
}

function buildServerDownEmbed(payload: NotificationPayload, ctx: ServerContext): DiscordEmbed {
  const text = textOf(payload, {
    title: 'Server Connection Lost',
    message: `Lost connection to ${ctx.serverName}`,
  });
  return { title: text.title, description: text.message, color: 0xff0000 }; // Red
}

function buildServerUpEmbed(payload: NotificationPayload, ctx: ServerContext): DiscordEmbed {
  const text = textOf(payload, {
    title: 'Server Back Online',
    message: `${ctx.serverName} is back online`,
  });
  return { title: text.title, description: text.message, color: 0x2ecc71 }; // Green
}

function buildPluginUpdateEmbed(
  payload: NotificationPayload,
  ctx: PluginUpdateContext
): DiscordEmbed {
  const text = textOf(payload, {
    title: 'Plugin Update Available',
    message: `${ctx.serverName}: ${formatPluginUpdateMessage(ctx)}`,
  });
  return { title: text.title, description: text.message, color: 0xf39c12 }; // Orange/Warning
}

function buildServerUpdateEmbed(
  payload: NotificationPayload,
  ctx: ServerUpdateContext
): DiscordEmbed {
  const text = textOf(payload, {
    title: 'Server Update Available',
    message: formatServerUpdateMessage(ctx),
  });
  return { title: text.title, description: text.message, color: 0xf39c12 }; // Orange/Warning
}

function buildTracearrUpdateEmbed(
  payload: NotificationPayload,
  ctx: TracearrUpdateContext
): DiscordEmbed {
  const text = textOf(payload, {
    title: 'Tracearr Update Available',
    message: formatTracearrUpdateMessage(ctx),
  });
  return { title: text.title, description: text.message, color: 0x3498db }; // Blue
}

/** Fields a media embed always carries; the year only when the item has one. */
function mediaFields(ctx: MediaAddedContext | MediaUpgradedContext): DiscordField[] {
  const fields: DiscordField[] = [
    { name: 'Library', value: ctx.libraryName, inline: true },
    { name: 'Server', value: ctx.serverName, inline: true },
  ];
  if (ctx.year !== null) {
    fields.push({ name: 'Year', value: String(ctx.year), inline: true });
  }
  return fields;
}

function linkField(links: { label: string; url: string }[]): DiscordField[] {
  if (links.length === 0) return [];
  return [
    {
      name: 'View details',
      value: links.map((l) => `[${l.label}](${l.url})`).join('  ·  '),
      inline: false,
    },
  ];
}

/**
 * A season says how many episodes came with it, an episode says which episode it is, and
 * everything else says it arrived. The parent is in the title, so the description carries
 * the item's own name.
 */
function buildMediaAddedEmbed(
  payload: NotificationPayload,
  ctx: MediaAddedContext,
  links: { label: string; url: string }[]
): DiscordEmbed {
  const subtitle = mediaSubtitle(ctx);
  const count =
    ctx.addedEpisodeCount === undefined || ctx.addedEpisodeCount === 0
      ? null
      : `${String(ctx.addedEpisodeCount)} ${ctx.addedEpisodeCount === 1 ? 'episode' : 'episodes'} added`;
  const lines = [subtitle === null ? null : `**${subtitle}**`, count].filter(
    (line): line is string => line !== null
  );

  const text = textOf(payload, { title: mediaHeadline(ctx), message: lines.join('\n') });

  return {
    author: { name: payload.automation?.name ?? 'New media added' },
    title: text.title,
    ...(text.message && { description: text.message }),
    ...(links[0] && { url: links[0].url }),
    color: 0x1abc9c, // Teal
    fields: [...mediaFields(ctx), ...linkField(links)],
    footer: { text: 'Tracearr' },
  };
}

/** One field per quality field that moved, so the whole improvement is visible at a glance. */
function buildMediaUpgradedEmbed(
  payload: NotificationPayload,
  ctx: MediaUpgradedContext,
  links: { label: string; url: string }[]
): DiscordEmbed {
  const subtitle = mediaSubtitle(ctx);
  const text = textOf(payload, {
    title: mediaHeadline(ctx),
    message: subtitle === null ? '' : `**${subtitle}**`,
  });

  const moves = qualityMoves(ctx).map((move) => ({
    name: move.label,
    value: move.move,
    inline: true,
  }));

  return {
    author: { name: payload.automation?.name ?? 'Media upgraded' },
    title: text.title,
    ...(text.message && { description: text.message }),
    ...(links[0] && { url: links[0].url }),
    color: 0x16a085, // Darker teal - a library event like media added, not the trust purple
    fields: [...moves, ...mediaFields(ctx), ...linkField(links)],
    footer: { text: 'Tracearr' },
  };
}

/** The events whose whole text the payload already carries; the colour is all that differs. */
function buildOwnText(payload: NotificationPayload, color: number): DiscordEmbed {
  const text = ownText(payload);
  return { title: text.title, description: text.message, color };
}

/**
 * The poster, as bytes. A miss degrades to no thumbnail rather than failing the send -
 * proxyImage answers an unreachable server with an SVG placeholder, which Discord will
 * not render, so only a raster image is worth uploading.
 */
async function fetchPoster(
  serverId: string,
  thumbPath: string | null
): Promise<{ data: Buffer; contentType: string } | undefined> {
  if (thumbPath === null || thumbPath === '') return undefined;
  try {
    const result = await proxyImage({
      serverId,
      imagePath: thumbPath,
      ...POSTER_IMAGE_SIZE,
      fallback: 'poster',
    });
    if (!result.contentType.startsWith('image/') || result.contentType.includes('svg')) {
      return undefined;
    }
    return { data: result.data, contentType: result.contentType };
  } catch {
    return undefined;
  }
}

async function buildMediaMessage(
  payload: NotificationPayload,
  ctx: MediaAddedContext | MediaUpgradedContext
): Promise<DiscordMessage> {
  const [links, poster] = await Promise.all([
    buildMediaLinks(ctx).catch(() => []),
    fetchPoster(ctx.serverId, ctx.thumbPath),
  ]);
  const embed =
    ctx.type === 'media_added'
      ? buildMediaAddedEmbed(payload, ctx, links)
      : buildMediaUpgradedEmbed(payload, ctx, links);
  if (!poster) return { embed };
  const filename = posterFilename(poster.contentType);
  return { embed: { ...embed, thumbnail: { url: `attachment://${filename}` } }, poster };
}

function embedChars(embed: DiscordEmbed): number {
  const fields = (embed.fields ?? []).reduce(
    (sum, field) => sum + [...field.name].length + [...field.value].length,
    0
  );
  return (
    [...embed.title].length +
    [...(embed.description ?? '')].length +
    fields +
    [...(embed.footer?.text ?? '')].length +
    [...(embed.author?.name ?? '')].length
  );
}

/** Discord rejects an embed over its limits rather than cutting it, so the text is cut here. */
export function fitEmbed(embed: DiscordEmbed): DiscordEmbed {
  const { description, ...rest } = embed;
  const title = PROFILE.title ? fitText(embed.title, PROFILE.title) : embed.title;
  let body = description && PROFILE.body ? fitText(description, PROFILE.body) : description;
  const fitted: DiscordEmbed = { ...rest, title };
  if (body) {
    const room = EMBED_TOTAL - embedChars(fitted);
    body = room > 1 ? fitText(body, { max: room, unit: 'chars' }) : undefined;
  }
  return body ? { ...fitted, description: body } : fitted;
}

/** Media events fetch a poster and their links; everything else renders from the payload alone. */
async function buildMessage(payload: NotificationPayload): Promise<DiscordMessage> {
  const message =
    payload.context.type === 'media_added' || payload.context.type === 'media_upgraded'
      ? await buildMediaMessage(payload, payload.context)
      : { embed: buildEmbed(payload) };
  return { ...message, embed: fitEmbed(message.embed) };
}

function buildEmbed(payload: NotificationPayload): DiscordEmbed {
  switch (payload.context.type) {
    case 'violation_detected':
      return buildViolationEmbed(payload, payload.context);
    case 'stream_started':
      return buildSessionStartedEmbed(payload, payload.context);
    case 'stream_stopped':
      return buildSessionStoppedEmbed(payload, payload.context);
    case 'server_down':
      return buildServerDownEmbed(payload, payload.context);
    case 'server_up':
      return buildServerUpEmbed(payload, payload.context);
    case 'plugin_update_available':
      return buildPluginUpdateEmbed(payload, payload.context);
    case 'server_update_available':
      return buildServerUpdateEmbed(payload, payload.context);
    case 'tracearr_update_available':
      return buildTracearrUpdateEmbed(payload, payload.context);
    case 'media_added':
      return buildMediaAddedEmbed(payload, payload.context, []);
    case 'media_upgraded':
      return buildMediaUpgradedEmbed(payload, payload.context, []);
    case 'new_device':
      return buildOwnText(payload, 0xf39c12); // Orange/Warning
    case 'trust_score_changed':
      return buildOwnText(payload, 0x9b59b6); // Purple
    case 'newsletter_send':
      return buildOwnText(payload, payload.context.outcome === 'sent' ? 0x2ecc71 : 0xe74c3c);
  }
}

/**
 * A poster rides along as multipart, which is the only way to get an image into an embed
 * without a URL Discord can reach. Content-Type is left unset on purpose so undici writes
 * the multipart boundary itself.
 */
async function post(
  webhookUrl: string,
  message: DiscordMessage,
  ctx: DeliverContext
): Promise<void> {
  const filename = message.poster && posterFilename(message.poster.contentType);
  const sender = discordSender();
  const payload = {
    username: sender.username,
    avatar_url: sender.avatarUrl,
    allowed_mentions: { parse: [] },
    embeds: [{ ...message.embed, timestamp: new Date().toISOString() }],
    ...(filename && { attachments: [{ id: 0, filename }] }),
  };

  if (!message.poster) {
    await deliverFetch(
      webhookUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      ctx
    );
    return;
  }

  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  form.append(
    'files[0]',
    new Blob([new Uint8Array(message.poster.data)], { type: message.poster.contentType }),
    filename ?? 'poster.jpg'
  );
  await deliverFetch(webhookUrl, { method: 'POST', body: form }, ctx);
}

export const discordType: DestinationType<DiscordConfig, DiscordMessage> = {
  kind: 'discord',
  events: DESTINATION_TYPES.discord.events,
  render: (event, _config, ctx) =>
    buildMessage(toNotificationPayload(event, ctx.source, escapeFor(PROFILE))),
  deliver: (message, config, ctx) => post(config.webhookUrl, message, ctx),
  test: (config, ctx) =>
    post(
      config.webhookUrl,
      {
        embed: {
          title: 'Test Notification',
          description: 'This is a test notification from Tracearr',
          color: 0x3498db,
        },
      },
      ctx
    ),
};
