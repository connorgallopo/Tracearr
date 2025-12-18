/**
 * Poller Utility Functions
 *
 * Pure utility functions for IP detection, client parsing, and formatting.
 * These functions have no side effects and are easily testable.
 */

// ============================================================================
// IP Address Utilities
// ============================================================================

/**
 * Check if an IP address is private/local (won't have GeoIP data)
 *
 * @param ip - IP address to check
 * @returns true if the IP is private/local
 *
 * @example
 * isPrivateIP('192.168.1.100'); // true
 * isPrivateIP('8.8.8.8');       // false
 */
export function isPrivateIP(ip: string): boolean {
  if (!ip) return true;

  // IPv4 private ranges
  const privateIPv4 = [
    /^10\./, // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
    /^192\.168\./, // 192.168.0.0/16
    /^127\./, // Loopback
    /^169\.254\./, // Link-local
    /^0\./, // Current network
  ];

  // IPv6 private ranges
  const privateIPv6 = [
    /^::1$/i, // Loopback
    /^fe80:/i, // Link-local
    /^fc/i, // Unique local
    /^fd/i, // Unique local
  ];

  return privateIPv4.some((r) => r.test(ip)) || privateIPv6.some((r) => r.test(ip));
}

// ============================================================================
// Client Parsing Utilities
// ============================================================================

/**
 * Parse platform and device info from Jellyfin client string
 *
 * Jellyfin clients report as "Jellyfin iOS", "Jellyfin Android", "Jellyfin Web", etc.
 * This function extracts meaningful platform and device information from these strings.
 *
 * @param client - Client application name string
 * @param deviceType - Optional device type hint
 * @returns Parsed platform and device information
 *
 * @example
 * parseJellyfinClient('Jellyfin iOS');        // { platform: 'iOS', device: 'iPhone' }
 * parseJellyfinClient('Jellyfin Web');        // { platform: 'Web', device: 'Browser' }
 * parseJellyfinClient('Swiftfin');            // { platform: 'tvOS', device: 'Apple TV' }
 */
export function parseJellyfinClient(
  client: string,
  deviceType?: string
): { platform: string; device: string } {
  // If deviceType is provided and meaningful, use it
  if (deviceType && deviceType.length > 0 && deviceType !== 'Unknown') {
    return { platform: client, device: deviceType };
  }

  const clientLower = client.toLowerCase();

  // iOS devices
  if (clientLower.includes('ios') || clientLower.includes('iphone')) {
    return { platform: 'iOS', device: 'iPhone' };
  }
  if (clientLower.includes('ipad')) {
    return { platform: 'iOS', device: 'iPad' };
  }

  // Android and NVIDIA Shield
  if (clientLower.includes('android')) {
    if (clientLower.includes('tv') || clientLower.includes('shield')) {
      return { platform: 'Android TV', device: 'Android TV' };
    }
    return { platform: 'Android', device: 'Android' };
  }
  // NVIDIA Shield without "android" in client name
  if (clientLower.includes('shield')) {
    return { platform: 'Android TV', device: 'Android TV' };
  }

  // Smart TVs
  if (clientLower.includes('samsung') || clientLower.includes('tizen')) {
    return { platform: 'Tizen', device: 'Samsung TV' };
  }
  if (clientLower.includes('webos') || clientLower.includes('lg')) {
    return { platform: 'webOS', device: 'LG TV' };
  }
  if (clientLower.includes('roku')) {
    return { platform: 'Roku', device: 'Roku' };
  }

  // Apple TV
  if (
    clientLower.includes('tvos') ||
    clientLower.includes('apple tv') ||
    clientLower.includes('swiftfin')
  ) {
    return { platform: 'tvOS', device: 'Apple TV' };
  }

  // Desktop/Web
  if (clientLower.includes('web')) {
    return { platform: 'Web', device: 'Browser' };
  }

  // Media players
  if (clientLower.includes('kodi')) {
    return { platform: 'Kodi', device: 'Kodi' };
  }
  if (clientLower.includes('infuse')) {
    return { platform: 'Infuse', device: 'Infuse' };
  }

  // Fallback
  return { platform: client || 'Unknown', device: deviceType || client || 'Unknown' };
}

// ============================================================================
// Formatting Utilities
// ============================================================================

/**
 * Format quality string from bitrate and transcoding info
 *
 * @param transcodeBitrate - Transcoded bitrate in bps (0 if not transcoding)
 * @param sourceBitrate - Original source bitrate in bps
 * @param isTranscoding - Whether the stream is being transcoded
 * @returns Formatted quality string (e.g., "12Mbps", "Transcoding", "Direct")
 *
 * @example
 * formatQualityString(12000000, 20000000, true);  // "12Mbps"
 * formatQualityString(0, 0, true);                 // "Transcoding"
 * formatQualityString(0, 0, false);                // "Direct"
 */
export function formatQualityString(
  transcodeBitrate: number,
  sourceBitrate: number,
  isTranscoding: boolean
): string {
  const bitrate = transcodeBitrate || sourceBitrate;
  return bitrate > 0
    ? `${Math.round(bitrate / 1000000)}Mbps`
    : isTranscoding
      ? 'Transcoding'
      : 'Direct';
}
