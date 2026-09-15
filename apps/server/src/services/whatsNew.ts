/**
 * What's-new dialog state: which version the owner last dismissed release notes on.
 */

import { normalizeVersion, WHATS_NEW_LEGACY, type WhatsNewState } from '@tracearr/shared';
import { getCurrentVersion } from '../utils/buildInfo.js';
import { getSetting, setSetting } from './settings.js';
import { getOwnerUser } from './userService.js';

/**
 * Owners are created on several paths (Better Auth hook, direct Plex inserts), so instead of
 * hooking each one, boot decides once: an owner already exists means the install predates the
 * dialog; no owner means a fresh install that has nothing new to see.
 */
export async function seedWhatsNewLastSeen(): Promise<void> {
  if ((await getSetting('whatsNewLastSeenVersion')) !== null) return;
  const owner = await getOwnerUser();
  await setSetting(
    'whatsNewLastSeenVersion',
    owner ? WHATS_NEW_LEGACY : normalizeVersion(getCurrentVersion())
  );
}

export async function getWhatsNewState(): Promise<WhatsNewState> {
  return {
    runningVersion: normalizeVersion(getCurrentVersion()),
    lastSeenVersion: await getSetting('whatsNewLastSeenVersion'),
  };
}

export async function dismissWhatsNew(): Promise<void> {
  await setSetting('whatsNewLastSeenVersion', normalizeVersion(getCurrentVersion()));
}
