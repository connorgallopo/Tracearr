import { useMemo } from 'react';
import type { Settings } from '@tracearr/shared';
import type { ActiveAgent, NotificationAgentType } from './types';
import { AGENT_CONFIGS, CUSTOM_WEBHOOK_AGENTS } from './agent-config';

/**
 * Truncate URL for display, showing domain and path start
 */
function truncateUrl(url: string, maxLength = 30): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : '';
    const display = `${parsed.host}${pathname}`;
    if (display.length <= maxLength) return display;
    return `${display.substring(0, maxLength - 3)}...`;
  } catch {
    const cleaned = url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (cleaned.length <= maxLength) return cleaned;
    return `${cleaned.substring(0, maxLength - 3)}...`;
  }
}

function joinUrlPath(baseUrl: string, segment: string): string {
  const base = truncateUrl(baseUrl);
  const cleanSegment = segment.replace(/^\/+/, '');
  if (!base) return cleanSegment;
  return `${base}/${cleanSegment}`;
}

/**
 * Derive active notification agents from current settings.
 * Returns a list of agents that are configured and ready to use.
 */
export function useActiveAgents(settings: Settings | undefined): ActiveAgent[] {
  return useMemo(() => {
    if (!settings) return [];

    const agents: ActiveAgent[] = [];

    // Web Toast - always present (default agent)
    agents.push({
      type: 'webToast',
      config: AGENT_CONFIGS.webToast,
      isConfigured: true,
    });

    // Discord - present if webhook URL is configured
    if (settings.discordWebhookUrl) {
      agents.push({
        type: 'discord',
        config: AGENT_CONFIGS.discord,
        isConfigured: true,
        displayValue: truncateUrl(settings.discordWebhookUrl),
      });
    }

    // Custom webhook agents - only ONE can be active based on webhookFormat
    if (
      settings.webhookFormat &&
      CUSTOM_WEBHOOK_AGENTS.includes(settings.webhookFormat as NotificationAgentType)
    ) {
      const agentType = settings.webhookFormat as NotificationAgentType;
      const config = AGENT_CONFIGS[agentType];

      if (config) {
        // Check if agent is properly configured
        let isConfigured = true;
        let displayValue: string | undefined;

        switch (agentType) {
          case 'ntfy':
            isConfigured = !!settings.customWebhookUrl && !!settings.ntfyTopic;
            displayValue =
              settings.customWebhookUrl && settings.ntfyTopic
                ? joinUrlPath(settings.customWebhookUrl, settings.ntfyTopic)
                : undefined;
            break;
          case 'pushover':
            isConfigured = !!settings.pushoverUserKey && !!settings.pushoverApiToken;
            displayValue = settings.pushoverUserKey
              ? `User: ${settings.pushoverUserKey.substring(0, 8)}...`
              : undefined;
            break;
          case 'apprise':
          case 'gotify':
          case 'json':
            isConfigured = !!settings.customWebhookUrl;
            displayValue = settings.customWebhookUrl
              ? truncateUrl(settings.customWebhookUrl)
              : undefined;
            break;
        }

        agents.push({
          type: agentType,
          config,
          isConfigured,
          displayValue,
        });
      }
    }

    // Mobile Push - only show if mobile is enabled and has active sessions
    // For now, we'll show it as a default but "not configured" if no mobile devices
    // This could be enhanced later to check for actual mobile sessions
    if (settings.mobileEnabled) {
      agents.push({
        type: 'push',
        config: AGENT_CONFIGS.push,
        isConfigured: true, // Always "configured" if mobile is enabled
        displayValue: 'Configured in Mobile settings',
      });
    }

    return agents;
  }, [settings]);
}

/**
 * Info about an agent type that can be added
 */
export interface AddableAgentInfo {
  type: NotificationAgentType;
  isAvailable: boolean;
  unavailableReason?: string;
  blockedBy?: NotificationAgentType;
}

/**
 * Get all addable agent types with their availability status.
 * Shows all agents but indicates which are unavailable and why.
 */
export function useAddableAgents(activeAgents: ActiveAgent[]): {
  discord: AddableAgentInfo | null;
  webhookAgents: AddableAgentInfo[];
  activeWebhookAgent: NotificationAgentType | null;
} {
  return useMemo(() => {
    const activeTypes = new Set(activeAgents.map((a) => a.type));

    const discord: AddableAgentInfo | null = activeTypes.has('discord')
      ? null
      : { type: 'discord', isAvailable: true };

    const activeWebhookAgent = CUSTOM_WEBHOOK_AGENTS.find((type) => activeTypes.has(type)) ?? null;

    const webhookAgents: AddableAgentInfo[] = CUSTOM_WEBHOOK_AGENTS.filter(
      (type) => !activeTypes.has(type)
    ).map((type) => {
      if (activeWebhookAgent) {
        return {
          type,
          isAvailable: false,
          unavailableReason: `Only one webhook agent can be active. Remove ${AGENT_CONFIGS[activeWebhookAgent].name} first.`,
          blockedBy: activeWebhookAgent,
        };
      }
      return { type, isAvailable: true };
    });

    return { discord, webhookAgents, activeWebhookAgent };
  }, [activeAgents]);
}

/**
 * Get agent types that are available to add (not already active)
 * @deprecated Use useAddableAgents instead for better UX
 */
export function useAvailableAgentTypes(activeAgents: ActiveAgent[]): NotificationAgentType[] {
  return useMemo(() => {
    const activeTypes = new Set(activeAgents.map((a) => a.type));
    const available: NotificationAgentType[] = [];

    // Discord can be added if not already active
    if (!activeTypes.has('discord')) {
      available.push('discord');
    }

    // Only one custom webhook agent can be active at a time
    const hasCustomWebhook = CUSTOM_WEBHOOK_AGENTS.some((type) => activeTypes.has(type));
    if (!hasCustomWebhook) {
      available.push(...CUSTOM_WEBHOOK_AGENTS);
    }

    return available;
  }, [activeAgents]);
}

/**
 * Get the currently active custom webhook agent type (if any)
 */
export function useActiveCustomWebhookAgent(
  activeAgents: ActiveAgent[]
): NotificationAgentType | null {
  return useMemo(() => {
    const found = activeAgents.find((a) => CUSTOM_WEBHOOK_AGENTS.includes(a.type));
    return found?.type ?? null;
  }, [activeAgents]);
}
