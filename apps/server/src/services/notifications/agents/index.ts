/**
 * Notification Agent Registry
 *
 * Exports all notification agents and provides a registration helper.
 */

export { BaseAgent } from './base.js';
export { DiscordAgent } from './discord.js';
export { NtfyAgent } from './ntfy.js';
export { AppriseAgent } from './apprise.js';
export { PushoverAgent } from './pushover.js';
export { JsonWebhookAgent } from './json-webhook.js';
export { GotifyAgent } from './gotify.js';

import type { NotificationAgent } from '../types.js';
import { DiscordAgent } from './discord.js';
import { NtfyAgent } from './ntfy.js';
import { AppriseAgent } from './apprise.js';
import { PushoverAgent } from './pushover.js';
import { JsonWebhookAgent } from './json-webhook.js';
import { GotifyAgent } from './gotify.js';

/**
 * Agent registry - lazy-loaded singleton instances
 */
const agentRegistry: Record<string, NotificationAgent> = {};

function getOrCreateAgent(name: string): NotificationAgent | undefined {
  if (agentRegistry[name]) {
    return agentRegistry[name];
  }

  // Lazy-create agent by name
  switch (name) {
    case 'discord':
      agentRegistry[name] = new DiscordAgent();
      break;
    case 'ntfy':
      agentRegistry[name] = new NtfyAgent();
      break;
    case 'apprise':
      agentRegistry[name] = new AppriseAgent();
      break;
    case 'pushover':
      agentRegistry[name] = new PushoverAgent();
      break;
    case 'json-webhook':
      agentRegistry[name] = new JsonWebhookAgent();
      break;
    case 'gotify':
      agentRegistry[name] = new GotifyAgent();
      break;
    default:
      return undefined;
  }

  return agentRegistry[name];
}

/**
 * Create instances of all available notification agents
 */
export function createAllAgents(): NotificationAgent[] {
  // Ensure all agents are created
  const names = ['discord', 'ntfy', 'gotify', 'apprise', 'pushover', 'json-webhook'];
  return names.map((name) => getOrCreateAgent(name)!);
}

/**
 * Get an agent by name (uses lazy-loaded registry)
 */
export function getAgentByName(name: string): NotificationAgent | undefined {
  return getOrCreateAgent(name);
}
