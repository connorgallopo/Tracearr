/**
 * Shared plugin update formatting utilities
 */

import { assertNever } from '@tracearr/shared';
import type { PluginUpdateContext } from '../types.js';

/**
 * Format a plugin update notification message with server-aware copy.
 * Jellyfin plugins are updated from the dashboard; Emby plugins require a manual download.
 */
export function formatPluginUpdateMessage(ctx: PluginUpdateContext): string {
  const installed = ctx.installedVersion ?? 'pre-0.2.0';

  switch (ctx.serverType) {
    case 'jellyfin':
      return `Update the Tracearr SSE plugin in Dashboard > Plugins (installed ${installed}, latest ${ctx.latestVersion})`;
    case 'emby':
      return `Download the new Tracearr SSE plugin build (installed ${installed}, latest ${ctx.latestVersion}): ${ctx.downloadUrl}`;
    default:
      return assertNever(ctx.serverType);
  }
}
