/**
 * Discord Webhook Notification Agent
 *
 * Sends rich embed messages to Discord webhooks.
 */

import { BaseAgent } from './base.js';
import type {
  NotificationPayload,
  NotificationSettings,
  NotificationEventType,
  SendResult,
  TestResult,
  ViolationContext,
  SessionContext,
  ServerContext,
  NewDeviceContext,
  TrustScoreChangedContext,
} from '../types.js';
import { formatViolationDetailsForDiscord, getSeverityInfo } from '../formatters/violation.js';
import { getNetworkSettings } from '../../settings.js';

/**
 * @see https://docs.discord.com/developers/resources/message#embed-object
 */
interface DiscordEmbed {
  title?: string;
  description?: string;
  timestamp?: string;
  color?: number;
  footer?: DiscordEmbedFooter;
  thumbnail?: DiscordEmbedImage;
  author?: DiscordEmbedAuthor;
  fields?: DiscordEmbedField[];
}

/**
 * @see https://docs.discord.com/developers/resources/message#embed-object-embed-footer-structure
 */
interface DiscordEmbedFooter {
  text: string;
  icon_url?: string;
}

/**
 * @see https://docs.discord.com/developers/resources/message#embed-object-embed-image-structure
 */
interface DiscordEmbedImage {
  url: string;
  description?: string;
}

/**
 * @see https://docs.discord.com/developers/resources/message#embed-object-embed-author-structure
 */
interface DiscordEmbedAuthor {
  name: string;
  url?: string;
  icon_url?: string;
}

/**
 * @see https://docs.discord.com/developers/resources/message#embed-object-embed-field-structure
 */
export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export class DiscordAgent extends BaseAgent {
  readonly name = 'discord';
  readonly displayName = 'Discord';

  shouldSend(_event: NotificationEventType, settings: NotificationSettings): boolean {
    return !!settings.discordWebhookUrl;
  }

  async send(payload: NotificationPayload, settings: NotificationSettings): Promise<SendResult> {
    if (!settings.discordWebhookUrl) {
      return this.handleError(new Error('Discord webhook URL not configured'), 'send');
    }

    try {
      const embed = await this.buildEmbed(payload);
      await this.sendWebhook(settings.discordWebhookUrl, embed);
      return this.successResult();
    } catch (error) {
      return this.handleError(error, 'send');
    }
  }

  async sendTest(settings: NotificationSettings): Promise<TestResult> {
    if (!settings.discordWebhookUrl) {
      return this.failureTestResult('Discord webhook URL not configured');
    }

    try {
      await this.sendWebhook(settings.discordWebhookUrl, {
        title: 'Test Notification',
        description: 'This is a test notification from Tracearr',
        color: 0x3498db,
      });
      return this.successTestResult();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return this.failureTestResult(message);
    }
  }

  private async buildEmbed(payload: NotificationPayload): Promise<DiscordEmbed> {
    switch (payload.context.type) {
      case 'violation_detected':
        return await this.buildViolationEmbed(payload, payload.context);
      case 'stream_started':
        return await this.buildSessionStartedEmbed(payload, payload.context);
      case 'stream_stopped':
        return await this.buildSessionStoppedEmbed(payload, payload.context);
      case 'server_down':
        return await this.buildServerDownEmbed(payload, payload.context);
      case 'server_up':
        return await this.buildServerUpEmbed(payload, payload.context);
      case 'new_device':
        return await this.buildNewDeviceEmbed(payload, payload.context);
      case 'trust_score_changed':
        return await this.buildTrustScoreChangedEmbed(payload, payload.context);
    }
  }

  private async buildViolationEmbed(
    _payload: NotificationPayload,
    ctx: ViolationContext
  ): Promise<DiscordEmbed> {
    const { violation } = ctx;
    const { label: severityLabel, color } = getSeverityInfo(violation.severity);
    const netSettings = await getNetworkSettings();
    const detailFields = formatViolationDetailsForDiscord(violation.rule.type, violation.data);

    return {
      color: color,
      author: {
        name: violation.user.identityName ?? violation.user.username,
        icon_url: violation.user.thumbUrl ? violation.user.thumbUrl : undefined,
      },
      title: 'Violation Detected',
      fields: [
        { name: 'Rule', value: violation.rule.name, inline: true },
        { name: 'Severity', value: severityLabel, inline: true },
        ...detailFields,
      ],
      footer: {
        text: ctx.violation.server?.name ?? 'Unknown Server',
        icon_url: this.getServerIconURL(ctx.violation.server?.type, netSettings.externalUrl),
      },
      timestamp: new Date().toISOString(),
    };
  }

  private async buildSessionStartedEmbed(
    _payload: NotificationPayload,
    ctx: SessionContext
  ): Promise<DiscordEmbed> {
    const { session } = ctx;
    const { title, subtitle } = this.getMediaDisplay(session);
    const netSettings = await getNetworkSettings();
    const poster = this.getMediaPosterURL(session, netSettings);

    return {
      color: this.getServerColorForDiscord(session.server.type),
      author: {
        name: this.getUserDisplayName(session),
        icon_url: this.getUserAvatarURL(session.user),
      },
      title: 'Now Playing',
      thumbnail: poster ? { url: poster, description: `Artwork for ${title}.` } : undefined,
      description: subtitle ? `### ${title}\n**${subtitle}**` : `### ${title}`,
      fields: [
        { name: 'Playback', value: this.getPlaybackType(session), inline: true },
        { name: 'Player', value: session.product || session.device || 'Unknown', inline: true },
        {
          name: 'Location',
          value: session.geoCity || session.geoCountry || 'Unknown',
          inline: true,
        },
      ],
      footer: {
        text: session.server.name,
        icon_url: this.getServerIconURL(session.server.type, netSettings.externalUrl),
      },
      timestamp: session.startedAt
        ? new Date(session.startedAt).toISOString()
        : new Date().toISOString(),
    };
  }

  private async buildSessionStoppedEmbed(
    _payload: NotificationPayload,
    ctx: SessionContext
  ): Promise<DiscordEmbed> {
    const { session } = ctx;
    const { title, subtitle } = this.getMediaDisplay(session);
    const netSettings = await getNetworkSettings();
    const poster = this.getMediaPosterURL(session, netSettings);

    return {
      color: this.getServerColorForDiscord(session.server.type),
      author: {
        name: this.getUserDisplayName(session),
        icon_url: this.getUserAvatarURL(session.user),
      },
      title: 'Stream Ended',
      thumbnail: poster ? { url: poster, description: `Artwork for ${title}.` } : undefined,
      description: subtitle ? `### ${title}\n**${subtitle}**` : `### ${title}`,
      fields: [
        { name: 'Duration', value: this.formatDuration(session.durationMs), inline: true },
        { name: 'Player', value: session.product || session.device || 'Unknown', inline: true },
        {
          name: 'Location',
          value: session.geoCity || session.geoCountry || 'Unknown',
          inline: true,
        },
      ],
      footer: {
        text: session.server.name,
        icon_url: this.getServerIconURL(session.server.type, netSettings.externalUrl),
      },
      timestamp: session.startedAt
        ? new Date(session.startedAt).toISOString()
        : new Date().toISOString(),
    };
  }

  private async buildServerDownEmbed(
    _payload: NotificationPayload,
    ctx: ServerContext
  ): Promise<DiscordEmbed> {
    return {
      color: 0xe74c3c, // Red
      title: 'Server Offline',
      footer: {
        text: ctx.serverName,
      },
      timestamp: new Date().toISOString(),
    };
  }

  private async buildServerUpEmbed(
    _payload: NotificationPayload,
    ctx: ServerContext
  ): Promise<DiscordEmbed> {
    return {
      color: 0x2ecc71, // Green
      title: 'Server Online',
      footer: {
        text: ctx.serverName,
      },
      timestamp: new Date().toISOString(),
    };
  }

  private async buildNewDeviceEmbed(
    _payload: NotificationPayload,
    ctx: NewDeviceContext
  ): Promise<DiscordEmbed> {
    const netSettings = await getNetworkSettings();

    return {
      color: this.getServerColorForDiscord(ctx.server.type),
      author: {
        name: ctx.userName,
        icon_url: this.getUserAvatarURL(ctx.user),
      },
      title: 'New Device Detected',
      fields: [
        { name: 'Device', value: ctx.deviceName || 'Unknown', inline: true },
        { name: 'Platform', value: ctx.platform || 'Unknown', inline: true },
        { name: 'Location', value: ctx.location || 'Unknown', inline: true },
      ],
      footer: {
        text: ctx.server.name,
        icon_url: this.getServerIconURL(ctx.server.type, netSettings.externalUrl),
      },
      timestamp: new Date().toISOString(),
    };
  }

  private async buildTrustScoreChangedEmbed(
    _payload: NotificationPayload,
    ctx: TrustScoreChangedContext
  ): Promise<DiscordEmbed> {
    const netSettings = await getNetworkSettings();
    const direction = ctx.newScore < ctx.previousScore ? 'Decreased' : 'Increased';

    return {
      color: ctx.newScore < ctx.previousScore ? 0xe74c3c : 0x2ecc71, // Red or Green
      author: {
        name: ctx.userName,
        icon_url: this.getUserAvatarURL(ctx.user),
      },
      title: `Trust Score ${direction}`,
      fields: [
        { name: 'Previous Score', value: String(ctx.previousScore), inline: true },
        { name: 'New Score', value: String(ctx.newScore), inline: true },
        { name: 'Reason', value: ctx.reason || 'Unknown', inline: true },
      ],
      footer: {
        text: ctx.server.name,
        icon_url: this.getServerIconURL(ctx.server.type, netSettings.externalUrl),
      },
      timestamp: new Date().toISOString(),
    };
  }

  private async sendWebhook(webhookUrl: string, embed: DiscordEmbed): Promise<void> {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Tracearr',
        embeds: [
          {
            ...embed,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    const text = await response.text().catch(() => '');

    if (!response.ok) {
      throw new Error(`Discord webhook failed: ${response.status} ${text}`.trim());
    }
  }
}
