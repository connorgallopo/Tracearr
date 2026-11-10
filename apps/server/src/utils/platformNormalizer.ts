/**
 * Platform Normalizer
 *
 * Normalizes client/platform names from various media servers (Plex, Jellyfin, Emby)
 * into consistent, display-friendly names for Tracearr.
 *
 * This utility is used by:
 * - Jellyfin poller
 * - Emby poller
 * - Plex poller
 * - Plex SSE handler
 * - Jellystat import
 * - Tautulli import
 *
 * All data entering Tracearr should go through this normalizer for consistency.
 */

import type { ServerType } from '@tracearr/shared';

export interface NormalizedClient {
  /** Normalized platform name (e.g., "Android TV", "iOS", "Kodi") */
  platform: string;
  /** Normalized device type (e.g., "Android TV", "iPhone", "Browser") */
  device: string;
}

/**
 * Normalize client/platform information from any media server
 *
 * @param client - Client application name (e.g., "Jellyfin Android TV", "Plex for iOS")
 * @param deviceType - Optional device type hint from the API
 * @param serverType - Type of media server for server-specific handling
 * @returns Normalized platform and device information
 *
 * @example
 * normalizeClient('Jellyfin Android TV');           // { platform: 'Android TV', device: 'Android TV' }
 * normalizeClient('Plex for iOS', 'iPhone');        // { platform: 'iOS', device: 'iPhone' }
 * normalizeClient('Emby for Kodi Next Gen');        // { platform: 'Kodi', device: 'Kodi' }
 * normalizeClient('AndroidTv');                     // { platform: 'Android TV', device: 'Android TV' }
 */
export function normalizeClient(
  client: string,
  deviceType?: string,
  _serverType?: ServerType
): NormalizedClient {
  // If deviceType is provided and meaningful, use it as device but still normalize platform
  const hasValidDeviceType = deviceType && deviceType.length > 0 && deviceType !== 'Unknown';
  const deviceTypeLower = (deviceType || '').toLowerCase();

  const clientLower = (client || '').toLowerCase();

  // ============================================================================
  // Legacy/Mystery Plex Clients (from Tautulli naming conventions)
  // ============================================================================
  if (clientLower === 'konvergo') {
    return {
      platform: 'Plex Media Player',
      device: hasValidDeviceType ? deviceType : 'Plex Media Player',
    };
  }
  if (clientLower === 'mystery 3') {
    return { platform: 'PlayStation', device: hasValidDeviceType ? deviceType : 'PlayStation 3' };
  }
  if (clientLower === 'mystery 4' || clientLower === 'webmaf') {
    return { platform: 'PlayStation', device: hasValidDeviceType ? deviceType : 'PlayStation 4' };
  }
  if (clientLower === 'mystery 5') {
    return { platform: 'Xbox', device: hasValidDeviceType ? deviceType : 'Xbox 360' };
  }
  // Legacy macOS naming from Plex
  if (clientLower === 'osx') {
    return { platform: 'macOS', device: hasValidDeviceType ? deviceType : 'Mac' };
  }

  // ============================================================================
  // DLNA Devices (check early - can have empty client with DLNA product)
  // ============================================================================
  if (clientLower.includes('dlna') || deviceTypeLower === 'dlna') {
    return { platform: 'DLNA', device: hasValidDeviceType ? deviceType : 'DLNA Device' };
  }

  // ============================================================================
  // iOS Devices
  // ============================================================================
  if (clientLower.includes('ios') || clientLower.includes('iphone')) {
    return { platform: 'iOS', device: hasValidDeviceType ? deviceType : 'iPhone' };
  }
  if (clientLower.includes('ipad')) {
    return { platform: 'iOS', device: hasValidDeviceType ? deviceType : 'iPad' };
  }

  // ============================================================================
  // Chromecast (before Android - Chromecast is distinct from Android)
  // ============================================================================
  if (clientLower.includes('chromecast')) {
    return { platform: 'Chromecast', device: hasValidDeviceType ? deviceType : 'Chromecast' };
  }

  // ============================================================================
  // Android Devices (including Nexus)
  // ============================================================================
  if (clientLower.includes('android') || clientLower.includes('nexus')) {
    if (clientLower.includes('tv') || clientLower.includes('shield')) {
      return { platform: 'Android TV', device: hasValidDeviceType ? deviceType : 'Android TV' };
    }
    return { platform: 'Android', device: hasValidDeviceType ? deviceType : 'Android' };
  }
  // NVIDIA Shield without "android" in client name
  if (clientLower.includes('shield')) {
    return { platform: 'Android TV', device: hasValidDeviceType ? deviceType : 'Android TV' };
  }

  // ============================================================================
  // Smart TVs
  // ============================================================================
  if (clientLower.includes('samsung') || clientLower.includes('tizen')) {
    return { platform: 'Tizen', device: hasValidDeviceType ? deviceType : 'Samsung TV' };
  }
  if (
    clientLower.includes('webos') ||
    clientLower.includes('lg') ||
    clientLower.includes('netcast')
  ) {
    return { platform: 'webOS', device: hasValidDeviceType ? deviceType : 'LG TV' };
  }
  if (clientLower.includes('roku')) {
    return { platform: 'Roku', device: hasValidDeviceType ? deviceType : 'Roku' };
  }
  if (clientLower.includes('fire') && clientLower.includes('tv')) {
    return { platform: 'Fire TV', device: hasValidDeviceType ? deviceType : 'Fire TV' };
  }
  if (clientLower.includes('vizio')) {
    return { platform: 'Vizio', device: hasValidDeviceType ? deviceType : 'Vizio TV' };
  }

  // ============================================================================
  // Apple TV
  // ============================================================================
  if (
    clientLower.includes('tvos') ||
    clientLower.includes('apple tv') ||
    clientLower.includes('swiftfin')
  ) {
    return { platform: 'tvOS', device: hasValidDeviceType ? deviceType : 'Apple TV' };
  }

  // ============================================================================
  // Gaming Consoles
  // ============================================================================
  if (clientLower.includes('xbox')) {
    return { platform: 'Xbox', device: hasValidDeviceType ? deviceType : 'Xbox' };
  }
  if (
    clientLower.includes('playstation') ||
    clientLower.includes('ps4') ||
    clientLower.includes('ps5')
  ) {
    return { platform: 'PlayStation', device: hasValidDeviceType ? deviceType : 'PlayStation' };
  }
  if (clientLower.includes('wii') || clientLower.includes('wiiu')) {
    return { platform: 'Wii U', device: hasValidDeviceType ? deviceType : 'Wii U' };
  }

  // ============================================================================
  // Desktop/Web
  // ============================================================================
  if (clientLower.includes('web')) {
    return { platform: 'Web', device: hasValidDeviceType ? deviceType : 'Browser' };
  }
  if (clientLower.includes('chrome')) {
    return { platform: 'Chrome', device: hasValidDeviceType ? deviceType : 'Browser' };
  }
  if (clientLower.includes('safari')) {
    return { platform: 'Safari', device: hasValidDeviceType ? deviceType : 'Browser' };
  }
  if (clientLower.includes('firefox')) {
    return { platform: 'Firefox', device: hasValidDeviceType ? deviceType : 'Browser' };
  }
  if (clientLower.includes('edge')) {
    return { platform: 'Edge', device: hasValidDeviceType ? deviceType : 'Browser' };
  }
  if (clientLower.includes('opera')) {
    return { platform: 'Opera', device: hasValidDeviceType ? deviceType : 'Browser' };
  }

  // ============================================================================
  // Desktop Apps
  // ============================================================================
  if (clientLower.includes('windows')) {
    return { platform: 'Windows', device: hasValidDeviceType ? deviceType : 'Windows' };
  }
  if (clientLower.includes('macos') || clientLower.includes('mac os')) {
    return { platform: 'macOS', device: hasValidDeviceType ? deviceType : 'Mac' };
  }
  if (clientLower.includes('linux')) {
    return { platform: 'Linux', device: hasValidDeviceType ? deviceType : 'Linux' };
  }

  // ============================================================================
  // Media Players (Jellyfin/Emby specific)
  // ============================================================================
  if (clientLower.includes('kodi')) {
    return { platform: 'Kodi', device: hasValidDeviceType ? deviceType : 'Kodi' };
  }
  if (clientLower.includes('infuse')) {
    return { platform: 'Infuse', device: hasValidDeviceType ? deviceType : 'Infuse' };
  }
  if (clientLower.includes('vlc')) {
    return { platform: 'VLC', device: hasValidDeviceType ? deviceType : 'VLC' };
  }
  if (clientLower.includes('mpv')) {
    return { platform: 'MPV', device: hasValidDeviceType ? deviceType : 'MPV' };
  }

  // ============================================================================
  // Third-party Jellyfin/Emby Clients
  // ============================================================================
  if (clientLower.includes('findroid')) {
    return { platform: 'Android', device: hasValidDeviceType ? deviceType : 'Android' };
  }
  if (clientLower.includes('finamp')) {
    return { platform: 'Finamp', device: hasValidDeviceType ? deviceType : 'Finamp' };
  }
  if (clientLower.includes('streamyfin')) {
    return { platform: 'Streamyfin', device: hasValidDeviceType ? deviceType : 'Streamyfin' };
  }
  if (clientLower.includes('jellybox')) {
    return { platform: 'JellyBox', device: hasValidDeviceType ? deviceType : 'JellyBox' };
  }
  if (clientLower.includes('gelli')) {
    return { platform: 'Gelli', device: hasValidDeviceType ? deviceType : 'Gelli' };
  }

  // ============================================================================
  // Plex-specific Clients
  // ============================================================================
  if (clientLower.includes('plexamp')) {
    return { platform: 'Plexamp', device: hasValidDeviceType ? deviceType : 'Plexamp' };
  }
  if (clientLower.includes('plex htpc')) {
    return { platform: 'Plex HTPC', device: hasValidDeviceType ? deviceType : 'Plex HTPC' };
  }
  if (clientLower.includes('plex media player')) {
    return {
      platform: 'Plex Media Player',
      device: hasValidDeviceType ? deviceType : 'Plex Media Player',
    };
  }
  if (clientLower.includes('synclounge') || clientLower.includes('plextogether')) {
    return { platform: 'SyncLounge', device: hasValidDeviceType ? deviceType : 'SyncLounge' };
  }

  // ============================================================================
  // Fallback: Use deviceType if valid, otherwise use client name
  // ============================================================================
  if (hasValidDeviceType) {
    return { platform: client || 'Unknown', device: deviceType };
  }

  return {
    platform: client || 'Unknown',
    device: deviceType || client || 'Unknown',
  };
}

/**
 * Normalize platform name only (for cases where we already have a platform string)
 *
 * This is useful when importing from sources like Tautulli that already provide
 * a platform field, but we want to ensure consistency.
 *
 * @param platform - Platform string from the source
 * @returns Normalized platform name
 *
 * @example
 * normalizePlatformName('android');     // 'Android'
 * normalizePlatformName('iOS');         // 'iOS'
 * normalizePlatformName('ROKU');        // 'Roku'
 */
export function normalizePlatformName(platform: string): string {
  if (!platform) return 'Unknown';

  const platformLower = platform.toLowerCase();

  // Normalize casing for common platforms
  // Note: More specific keys should come before less specific ones for partial matching
  const platformMap: Record<string, string> = {
    // Mobile
    ios: 'iOS',
    'android tv': 'Android TV',
    androidtv: 'Android TV',
    android: 'Android',
    // Apple
    tvos: 'tvOS',
    'apple tv': 'tvOS',
    macos: 'macOS',
    'mac os': 'macOS',
    osx: 'macOS',
    // Smart TVs
    roku: 'Roku',
    tizen: 'Tizen',
    samsung: 'Tizen',
    webos: 'webOS',
    netcast: 'webOS',
    'fire tv': 'Fire TV',
    firetv: 'Fire TV',
    vizio: 'Vizio',
    chromecast: 'Chromecast',
    dlna: 'DLNA',
    // Gaming
    xbox: 'Xbox',
    playstation: 'PlayStation',
    wiiu: 'Wii U',
    'wii u': 'Wii U',
    wii: 'Wii U',
    // Desktop
    windows: 'Windows',
    linux: 'Linux',
    // Browsers
    chrome: 'Chrome',
    safari: 'Safari',
    firefox: 'Firefox',
    edge: 'Edge',
    opera: 'Opera',
    web: 'Web',
    // Media Players
    kodi: 'Kodi',
    infuse: 'Infuse',
    vlc: 'VLC',
    mpv: 'MPV',
    // Plex clients
    'plex web': 'Web',
    'plex for ios': 'iOS',
    'plex for android': 'Android',
    plexamp: 'Plexamp',
    'plex htpc': 'Plex HTPC',
    'plex media player': 'Plex Media Player',
    synclounge: 'SyncLounge',
    plextogether: 'SyncLounge',
    konvergo: 'Plex Media Player',
    // Jellyfin clients
    swiftfin: 'tvOS',
    findroid: 'Android',
    finamp: 'Finamp',
    streamyfin: 'Streamyfin',
    jellybox: 'JellyBox',
    gelli: 'Gelli',
  };

  // Check exact matches first
  if (platformMap[platformLower]) {
    return platformMap[platformLower];
  }

  // Check partial matches
  for (const [key, value] of Object.entries(platformMap)) {
    if (platformLower.includes(key)) {
      return value;
    }
  }

  // Return original with proper casing (capitalize first letter)
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}
