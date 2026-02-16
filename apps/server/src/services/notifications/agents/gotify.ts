/**
 * Gotify Notification Agent
 *
 * Sends notifications to Gotify servers.
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
import { formatViolationMessage } from '../formatters/violation.js';

interface GotifyPayload {
  title: string;
  message: string;
  priority: number;
}

export class GotifyAgent extends BaseAgent {
  readonly name = 'gotify';
  readonly displayName = 'Gotify';

  shouldSend(_event: NotificationEventType, settings: NotificationSettings): boolean {
    return settings.webhookFormat === 'gotify' && !!settings.customWebhookUrl;
  }

  async send(payload: NotificationPayload, settings: NotificationSettings): Promise<SendResult> {
    if (!settings.customWebhookUrl) {
      return this.handleError(new Error('Custom webhook URL not configured'), 'send');
    }

    try {
      const gotifyPayload = this.buildGotifyPayload(payload);
      await this.sendWebhook(settings.customWebhookUrl, gotifyPayload);
      return this.successResult();
    } catch (error) {
      return this.handleError(error, 'send');
    }
  }

  async sendTest(settings: NotificationSettings): Promise<TestResult> {
    if (!settings.customWebhookUrl) {
      return this.failureTestResult('Custom webhook URL not configured');
    }

    try {
      const payload: GotifyPayload = {
        title: 'Test Notification',
        message: 'This is a test notification from Tracearr',
        priority: 3,
      };
      await this.sendWebhook(settings.customWebhookUrl, payload);
      return this.successTestResult();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return this.failureTestResult(message);
    }
  }

  private buildGotifyPayload(payload: NotificationPayload): GotifyPayload {
    switch (payload.context.type) {
      case 'violation_detected':
        return this.buildViolationPayload(payload.context);
      case 'stream_started':
        return this.buildSessionStartedPayload(payload.context);
      case 'stream_stopped':
        return this.buildSessionStoppedPayload(payload.context);
      case 'server_down':
        return this.buildServerDownPayload(payload.context);
      case 'server_up':
        return this.buildServerUpPayload(payload.context);
      case 'new_device':
        return this.buildNewDevicePayload(payload.context);
      case 'trust_score_changed':
        return this.buildTrustScoreChangedPayload(payload.context);
    }
  }

  private buildViolationPayload(ctx: ViolationContext): GotifyPayload {
    return {
      title: 'Violation Detected',
      message: formatViolationMessage(ctx.violation),
      priority: this.severityToGotifyPriority(ctx.violation.severity),
    };
  }

  private buildSessionStartedPayload(ctx: SessionContext): GotifyPayload {
    const { session } = ctx;
    const { title: mediaTitle, subtitle } = this.getMediaDisplay(session);
    const userName = this.getUserDisplayName(session);
    const mediaDisplay = subtitle ? `${mediaTitle} - ${subtitle}` : mediaTitle;

    return {
      title: 'Stream Started',
      message: `${userName} started watching ${mediaDisplay}`,
      priority: 3,
    };
  }

  private buildSessionStoppedPayload(ctx: SessionContext): GotifyPayload {
    const { session } = ctx;
    const { title: mediaTitle, subtitle } = this.getMediaDisplay(session);
    const userName = this.getUserDisplayName(session);
    const mediaDisplay = subtitle ? `${mediaTitle} - ${subtitle}` : mediaTitle;
    const durationStr = session.durationMs ? ` (${this.formatDuration(session.durationMs)})` : '';

    return {
      title: 'Stream Ended',
      message: `${userName} finished watching ${mediaDisplay}${durationStr}`,
      priority: 3,
    };
  }

  private buildServerDownPayload(ctx: ServerContext): GotifyPayload {
    return {
      title: 'Server Offline',
      message: `${ctx.serverName} is not responding`,
      priority: 5,
    };
  }

  private buildServerUpPayload(ctx: ServerContext): GotifyPayload {
    return {
      title: 'Server Online',
      message: `${ctx.serverName} is back online`,
      priority: 4,
    };
  }

  private buildNewDevicePayload(ctx: NewDeviceContext): GotifyPayload {
    const locationStr = ctx.location ? ` from ${ctx.location}` : '';
    return {
      title: 'New Device Detected',
      message: `${ctx.userName} connected from a new device: ${ctx.deviceName}${locationStr}`,
      priority: 4,
    };
  }

  private buildTrustScoreChangedPayload(ctx: TrustScoreChangedContext): GotifyPayload {
    const direction = ctx.newScore < ctx.previousScore ? 'decreased' : 'increased';
    const reasonStr = ctx.reason ? `: ${ctx.reason}` : '';
    return {
      title: 'Trust Score Changed',
      message: `${ctx.userName}'s trust score ${direction} from ${ctx.previousScore} to ${ctx.newScore}${reasonStr}`,
      priority: ctx.newScore < ctx.previousScore ? 4 : 3,
    };
  }

  private severityToGotifyPriority(severity: string): number {
    const map: Record<string, number> = { high: 5, warning: 4, low: 3 };
    return map[severity] ?? 3;
  }

  private async sendWebhook(webhookUrl: string, payload: GotifyPayload): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Gotify webhook failed: ${response.status} ${text}`.trim());
    }
  }
}
