import { Globe, MessageSquare, Bell, Share2, Smartphone, Webhook } from 'lucide-react';
import type { AgentConfig, NotificationAgentType } from './types';

/**
 * Static configuration for all notification agent types.
 * Used to render UI and validate settings.
 */
export const AGENT_CONFIGS: Record<NotificationAgentType, AgentConfig> = {
  webToast: {
    type: 'webToast',
    name: 'Web Notifications',
    icon: Globe,
    description: 'Browser toast notifications',
    isDefault: true,
    isRemovable: false,
    routingChannel: 'webToast',
    fields: [],
  },

  discord: {
    type: 'discord',
    name: 'Discord',
    icon: MessageSquare,
    imagePath: '/images/notification-agents/discord.png',
    description: 'Send notifications to a Discord channel',
    isRemovable: true,
    routingChannel: 'discord',
    fields: [
      {
        key: 'discordWebhookUrl',
        label: 'Webhook URL',
        type: 'url',
        placeholder: 'https://discord.com/api/webhooks/...',
        required: true,
      },
    ],
  },

  ntfy: {
    type: 'ntfy',
    name: 'ntfy',
    icon: Bell,
    imagePath: '/images/notification-agents/ntfy.png',
    description: 'Push notifications via ntfy.sh',
    isRemovable: true,
    webhookFormat: 'ntfy',
    routingChannel: 'webhook',
    fields: [
      {
        key: 'customWebhookUrl',
        label: 'Server URL',
        type: 'url',
        placeholder: 'https://ntfy.sh/',
        required: true,
      },
      {
        key: 'ntfyTopic',
        label: 'Topic',
        type: 'text',
        placeholder: 'tracearr',
        required: true,
      },
      {
        key: 'ntfyAuthToken',
        label: 'Auth Token',
        type: 'secret',
        placeholder: 'Optional for public topics',
        required: false,
      },
    ],
  },

  gotify: {
    type: 'gotify',
    name: 'Gotify',
    icon: Bell,
    imagePath: '/images/notification-agents/gotify.png',
    description: 'Push notifications via Gotify',
    isRemovable: true,
    webhookFormat: 'gotify',
    routingChannel: 'webhook',
    fields: [
      {
        key: 'customWebhookUrl',
        label: 'Server URL',
        type: 'url',
        placeholder: 'https://gotify.example.com/message?token=yourtoken',
        required: true,
      },
    ],
  },

  apprise: {
    type: 'apprise',
    name: 'Apprise',
    icon: Share2,
    imagePath: '/images/notification-agents/apprise.png',
    description: 'Multi-service notifications via Apprise API',
    isRemovable: true,
    webhookFormat: 'apprise',
    routingChannel: 'webhook',
    fields: [
      {
        key: 'customWebhookUrl',
        label: 'Apprise API URL',
        type: 'url',
        placeholder: 'http://apprise:8000/notify/myconfig',
        required: true,
      },
    ],
  },

  pushover: {
    type: 'pushover',
    name: 'Pushover',
    icon: Smartphone,
    imagePath: '/images/notification-agents/pushover.png',
    description: 'Push notifications via Pushover',
    isRemovable: true,
    webhookFormat: 'pushover',
    routingChannel: 'webhook',
    fields: [
      {
        key: 'pushoverUserKey',
        label: 'User Key',
        type: 'text',
        placeholder: 'Your Pushover user key',
        required: true,
      },
      {
        key: 'pushoverApiToken',
        label: 'API Token',
        type: 'secret',
        placeholder: 'Your application API token',
        required: true,
      },
    ],
  },

  json: {
    type: 'json',
    name: 'JSON Webhook',
    icon: Webhook,
    description: 'Send raw JSON to a custom endpoint',
    isRemovable: true,
    webhookFormat: 'json',
    routingChannel: 'webhook',
    fields: [
      {
        key: 'customWebhookUrl',
        label: 'Webhook URL',
        type: 'url',
        placeholder: 'https://your-service.com/webhook',
        required: true,
      },
    ],
  },

  push: {
    type: 'push',
    name: 'Mobile Push',
    icon: Smartphone,
    description: 'Push notifications to paired mobile devices',
    isDefault: true,
    isRemovable: false,
    routingChannel: 'push',
    fields: [],
  },
};

/**
 * Agent types that can be added by the user (excludes defaults)
 */
export const ADDABLE_AGENT_TYPES: NotificationAgentType[] = [
  'discord',
  'ntfy',
  'gotify',
  'apprise',
  'pushover',
  'json',
];

/**
 * Agent types that share the customWebhookUrl (only one can be active)
 */
export const CUSTOM_WEBHOOK_AGENTS: NotificationAgentType[] = [
  'ntfy',
  'gotify',
  'apprise',
  'pushover',
  'json',
];
