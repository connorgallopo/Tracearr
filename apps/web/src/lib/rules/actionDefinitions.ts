/**
 * Action type definitions for the Rules Builder V2.
 *
 * This is the single source of truth for action metadata in the UI.
 * All action-related components reference this registry.
 */

import type { ActionType, ViolationSeverity, Action } from '@tracearr/shared';

// Config field types for rendering action configuration
export type ConfigFieldType = 'number' | 'text' | 'select' | 'slider' | 'destinations';

// Option definition for select fields
export interface ConfigFieldOption {
  value: string;
  label: string;
  /** Tooltip shown on hover */
  tooltip?: string;
}

// Config field definition
export interface ConfigField {
  name: string;
  label: string;
  type: ConfigFieldType;
  required?: boolean;
  options?: ConfigFieldOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  description?: string;
  /** If true, renders on its own line below other fields */
  fullWidth?: boolean;
}

// Action definition interface
export interface ActionDefinition {
  type: ActionType;
  label: string;
  description: string;
  icon: string; // Lucide icon name
  configFields: ConfigField[];
  color: 'default' | 'warning' | 'destructive';
  hint?: string; // Optional warning/info message to display
}

// Severity options for violation actions
export const SEVERITY_OPTIONS: { value: ViolationSeverity; label: string; color: string }[] = [
  { value: 'low', label: 'Low', color: 'bg-blue-500' },
  { value: 'warning', label: 'Warning', color: 'bg-yellow-500' },
  { value: 'high', label: 'High', color: 'bg-red-500' },
];

// Session target options for kill_stream and message_client actions
export const SESSION_TARGET_OPTIONS: ConfigFieldOption[] = [
  {
    value: 'triggering',
    label: 'Triggering session',
    tooltip: 'Only the session that triggered this rule',
  },
  {
    value: 'oldest',
    label: 'Oldest session',
    tooltip: "The user's longest-running active session",
  },
  {
    value: 'newest',
    label: 'Newest session',
    tooltip: "The user's most recently started session",
  },
  {
    value: 'all_except_one',
    label: 'All except one (keep oldest)',
    tooltip: 'All sessions except the oldest, bringing user down to 1 stream',
  },
  {
    value: 'all_user',
    label: 'All user sessions',
    tooltip: 'Every active session for this user',
  },
];

// The main action definitions registry
export const ACTION_DEFINITIONS: Record<ActionType, ActionDefinition> = {
  log_only: {
    type: 'log_only',
    label: 'Log Only',
    description: 'Log the event without taking action',
    icon: 'FileText',
    color: 'default',
    configFields: [
      {
        name: 'message',
        label: 'Log Message',
        type: 'text',
        placeholder: 'Optional custom message',
        description: 'Custom message to include in the log',
      },
    ],
  },

  send: {
    type: 'send',
    label: 'Send Notification',
    description: 'Send to one or more destinations',
    icon: 'Bell',
    color: 'default',
    configFields: [
      {
        name: 'to',
        label: 'Destinations',
        type: 'destinations',
        required: true,
      },
      {
        name: 'cooldown_minutes',
        label: 'Cooldown',
        type: 'number',
        min: 0,
        max: 1440,
        step: 5,
        unit: 'minutes',
        description: 'Minimum time between notifications',
      },
    ],
  },

  adjust_trust: {
    type: 'adjust_trust',
    label: 'Adjust Trust Score',
    description: 'Increase or decrease trust score',
    icon: 'TrendingUp',
    color: 'default',
    configFields: [
      {
        name: 'amount',
        label: 'Amount',
        type: 'number',
        required: true,
        min: -100,
        max: 100,
        step: 1,
        description: 'Positive to increase, negative to decrease',
      },
    ],
  },

  set_trust: {
    type: 'set_trust',
    label: 'Set Trust Score',
    description: 'Set trust score to specific value',
    icon: 'Target',
    color: 'default',
    configFields: [
      {
        name: 'value',
        label: 'Value',
        type: 'slider',
        required: true,
        min: 0,
        max: 100,
        step: 1,
      },
    ],
  },

  reset_trust: {
    type: 'reset_trust',
    label: 'Reset Trust Score',
    description: 'Reset trust score to default (100)',
    icon: 'RotateCcw',
    color: 'default',
    configFields: [],
  },

  kill_stream: {
    type: 'kill_stream',
    label: 'Kill Stream',
    description: 'Terminate the active stream',
    icon: 'XCircle',
    color: 'destructive',
    configFields: [
      {
        name: 'cooldown_minutes',
        label: 'Cooldown',
        type: 'number',
        min: 0,
        max: 1440,
        step: 5,
        unit: 'minutes',
        description: 'Minimum time between terminations for the same user',
      },
      {
        name: 'delay_seconds',
        label: 'Sustain window (seconds)',
        type: 'number',
        min: 0,
        max: 300,
        step: 5,
        unit: 'seconds',
        description:
          'Wait this many seconds, then kill the stream only if the rule still matches. 0 kills immediately after a final re-check.',
      },
      {
        name: 'target',
        label: 'Target',
        type: 'select',
        options: SESSION_TARGET_OPTIONS,
        description: 'Which sessions to terminate',
        fullWidth: true,
      },
      {
        name: 'message',
        label: 'Message',
        type: 'text',
        placeholder: 'Message shown to user (optional)',
        description: 'Text displayed before termination. Leave empty for silent termination.',
        fullWidth: true,
      },
    ],
  },

  message_client: {
    type: 'message_client',
    label: 'Message Client',
    description: 'Send message to the media player',
    icon: 'MessageSquare',
    color: 'default',
    hint: 'Jellyfin and Emby only. Plex only supports messages when killing a stream.',
    configFields: [
      {
        name: 'target',
        label: 'Target',
        type: 'select',
        options: SESSION_TARGET_OPTIONS,
        description: 'Which sessions to message',
        fullWidth: true,
      },
      {
        name: 'message',
        label: 'Message',
        type: 'text',
        required: true,
        placeholder: 'Message to display...',
        description: 'Text shown to the user',
      },
      {
        name: 'header',
        label: 'Header',
        type: 'text',
        placeholder: 'Tracearr',
        description: 'Title shown above the message (defaults to "Tracearr")',
      },
      {
        name: 'timeout_ms',
        label: 'Timeout',
        type: 'number',
        min: 0,
        max: 600000,
        step: 1000,
        unit: 'ms',
        description:
          'Auto-dismiss after this many milliseconds (default 10000). ' +
          'Set 0 for a persistent dialog on Jellyfin web that stays until dismissed. ' +
          'TV clients show a brief toast regardless of this value.',
      },
    ],
  },
};

// Helper functions

/**
 * Get action definition by type
 */
export function getActionDefinition(type: ActionType): ActionDefinition {
  return ACTION_DEFINITIONS[type];
}

/**
 * Get all action types
 */
export function getAllActionTypes(): ActionType[] {
  return Object.keys(ACTION_DEFINITIONS) as ActionType[];
}

/**
 * Create a default action of a given type
 */
export function createDefaultAction(type: ActionType): Action {
  switch (type) {
    case 'log_only':
      return { type: 'log_only' };
    case 'send':
      return { type: 'send', to: [] };
    case 'adjust_trust':
      return { type: 'adjust_trust', amount: -10 };
    case 'set_trust':
      return { type: 'set_trust', value: 50 };
    case 'reset_trust':
      return { type: 'reset_trust' };
    case 'kill_stream':
      return { type: 'kill_stream' };
    case 'message_client':
      return { type: 'message_client', message: '' };
    default:
      return { type: 'log_only' };
  }
}
