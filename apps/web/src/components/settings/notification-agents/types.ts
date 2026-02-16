import type { LucideIcon } from 'lucide-react';
import type { NotificationEventType, WebhookFormat } from '@tracearr/shared';

/**
 * Available notification agent types
 */
export type NotificationAgentType =
  | 'webToast'
  | 'discord'
  | 'ntfy'
  | 'gotify'
  | 'apprise'
  | 'pushover'
  | 'json'
  | 'push';

/**
 * Maps agent types to their routing column in notificationChannelRouting table
 */
export type RoutingChannel = 'webToast' | 'discord' | 'webhook' | 'push';

/**
 * Configuration for a field in the agent's settings form
 */
export interface AgentFieldConfig {
  /** Settings key (e.g., 'discordWebhookUrl') */
  key: string;
  /** Display label */
  label: string;
  /** Field type determines input component */
  type: 'url' | 'text' | 'secret';
  /** Placeholder text */
  placeholder?: string;
  /** Whether field is required for the agent to be active */
  required?: boolean;
}

function validateUrl(url: string): string | null {
  // Must start with http:// or https://
  if (!/^https?:\/\//i.test(url)) {
    return 'URL must start with http:// or https://';
  }

  const afterProtocol = url.replace(/^https?:\/\//i, '');
  if (!afterProtocol || afterProtocol === '/') {
    return 'Please enter a valid URL';
  }

  const hostPart = afterProtocol.split('/')[0];
  if (!hostPart || /\s/.test(hostPart)) {
    return 'Please enter a valid URL';
  }

  return null;
}

export function validateField(field: AgentFieldConfig, value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';

  if (field.required && !trimmed) {
    return `${field.label} is required`;
  }

  if (!trimmed) return null;

  if (field.type === 'url') {
    return validateUrl(trimmed);
  }

  return null;
}

/**
 * Static configuration for an agent type
 */
export interface AgentConfig {
  /** Agent type identifier */
  type: NotificationAgentType;
  /** Display name */
  name: string;
  /** Lucide icon component (fallback) */
  icon: LucideIcon;
  /** Custom image path (preferred over icon if set) */
  imagePath?: string;
  /** Short description */
  description: string;
  /** Whether this is a default agent (always shown, can't be removed) */
  isDefault?: boolean;
  /** Whether this agent can be removed */
  isRemovable: boolean;
  /** For custom webhook agents - which format this maps to */
  webhookFormat?: WebhookFormat;
  /** The routing column this agent uses */
  routingChannel: RoutingChannel;
  /** Configuration fields for this agent */
  fields: AgentFieldConfig[];
}

/**
 * Runtime state of an active agent derived from settings
 */
export interface ActiveAgent {
  /** Agent type */
  type: NotificationAgentType;
  /** Static config for this agent type */
  config: AgentConfig;
  /** Whether the agent is fully configured (all required fields set) */
  isConfigured: boolean;
  /** Display string for the agent (e.g., webhook URL preview) */
  displayValue?: string;
}

/**
 * Event configuration for display in UI
 */
export interface EventConfig {
  name: string;
  description: string;
}

/**
 * Event types that can be configured for notification routing
 * Excludes concurrent_streams (it's a rule type, covered by violation_detected)
 */
export const NOTIFICATION_EVENT_ORDER: NotificationEventType[] = [
  'violation_detected',
  'new_device',
  'trust_score_changed',
  'stream_started',
  'stream_stopped',
  'server_down',
  'server_up',
];

export const NOTIFICATION_EVENT_CONFIG: Partial<Record<NotificationEventType, EventConfig>> = {
  violation_detected: {
    name: 'Rule Violation',
    description: 'A user triggered a rule violation',
  },
  new_device: {
    name: 'New Device',
    description: 'A user logged in from a new device',
  },
  trust_score_changed: {
    name: 'Trust Score Changed',
    description: "A user's trust score changed",
  },
  stream_started: {
    name: 'Stream Started',
    description: 'A user started watching content',
  },
  stream_stopped: {
    name: 'Stream Stopped',
    description: 'A user stopped watching content',
  },
  server_down: {
    name: 'Server Offline',
    description: 'A media server became unreachable',
  },
  server_up: {
    name: 'Server Online',
    description: 'A media server came back online',
  },
};
