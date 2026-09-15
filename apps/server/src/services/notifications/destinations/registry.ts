import type { DestinationKind } from '@tracearr/shared';
import { appriseType } from './apprise.js';
import { discordType } from './discord.js';
import { emailType } from './email.js';
import { gotifyType } from './gotify.js';
import { jsonWebhookType } from './jsonWebhook.js';
import { ntfyType } from './ntfy.js';
import { pushType } from './push.js';
import { pushoverType } from './pushover.js';
import { webToastType } from './webToast.js';
import type { DestinationType } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry: Record<DestinationKind, DestinationType<any, any>> = {
  discord: discordType,
  json_webhook: jsonWebhookType,
  ntfy: ntfyType,
  gotify: gotifyType,
  apprise: appriseType,
  pushover: pushoverType,
  email: emailType,
  push: pushType,
  web_toast: webToastType,
};

export function getDestinationType(
  kind: DestinationKind
): DestinationType<Record<string, unknown>, unknown> {
  return registry[kind] as DestinationType<Record<string, unknown>, unknown>;
}
