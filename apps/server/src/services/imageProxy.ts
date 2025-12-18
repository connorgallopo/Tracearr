/**
 * Image proxy service for Plex/Jellyfin images
 *
 * Fetches images from media servers, resizes them, and caches to disk.
 * This avoids CORS issues and reduces bandwidth to media servers.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { TIME_MS } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
// Token encryption removed - tokens now stored in plain text (DB is localhost-only)

// Cache directory (in project root/data/image-cache)
const CACHE_DIR = join(process.cwd(), 'data', 'image-cache');
const CACHE_TTL_MS = TIME_MS.DAY;
const MAX_CACHE_SIZE_MB = 500; // Maximum cache size in MB

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

// Fallback SVG placeholders
const FALLBACK_POSTER = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
  <rect width="300" height="450" fill="#1a1a2e"/>
  <g transform="translate(110, 180)" fill="#4a4a6a">
    <rect x="0" y="0" width="80" height="100" rx="4"/>
    <circle cx="40" cy="35" r="15"/>
    <path d="M10 75 L35 50 L50 65 L70 45 L90 75 Z" fill="#3a3a5a"/>
  </g>
  <text x="150" y="320" text-anchor="middle" fill="#6a6a8a" font-family="system-ui" font-size="14">No Image</text>
</svg>`;

const FALLBACK_AVATAR = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#1a1a2e" rx="50"/>
  <circle cx="50" cy="38" r="18" fill="#4a4a6a"/>
  <ellipse cx="50" cy="85" rx="28" ry="22" fill="#4a4a6a"/>
</svg>`;

const FALLBACK_ART = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="280" viewBox="0 0 500 280">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a2e"/>
      <stop offset="100%" style="stop-color:#0f0f1a"/>
    </linearGradient>
  </defs>
  <rect width="500" height="280" fill="url(#grad)"/>
</svg>`;

export type FallbackType = 'poster' | 'avatar' | 'art';

interface ProxyOptions {
  serverId: string;
  imagePath: string;
  width?: number;
  height?: number;
  fallback?: FallbackType;
}

interface ProxyResult {
  data: Buffer;
  contentType: string;
  cached: boolean;
}

/**
 * Generate a cache key from the request parameters
 */
function getCacheKey(serverId: string, imagePath: string, width: number, height: number): string {
  const hash = createHash('sha256')
    .update(`${serverId}:${imagePath}:${width}:${height}`)
    .digest('hex')
    .slice(0, 16);
  return `${hash}.webp`;
}

/**
 * Get fallback SVG buffer
 */
function getFallbackImage(type: FallbackType, _width: number, _height: number): Buffer {
  let svg: string;
  switch (type) {
    case 'avatar':
      svg = FALLBACK_AVATAR;
      break;
    case 'art':
      svg = FALLBACK_ART;
      break;
    case 'poster':
    default:
      svg = FALLBACK_POSTER;
      break;
  }

  // Return the SVG resized to requested dimensions
  return Buffer.from(svg);
}

/**
 * Clean up old cache files
 */
async function cleanupCache(): Promise<void> {
  try {
    const files = readdirSync(CACHE_DIR);
    const now = Date.now();
    let totalSize = 0;
    const fileStats: Array<{ name: string; size: number; mtime: number }> = [];

    for (const file of files) {
      const filePath = join(CACHE_DIR, file);
      try {
        const stat = statSync(filePath);
        totalSize += stat.size;
        fileStats.push({ name: file, size: stat.size, mtime: stat.mtimeMs });

        // Delete files older than TTL
        if (now - stat.mtimeMs > CACHE_TTL_MS) {
          unlinkSync(filePath);
          totalSize -= stat.size;
        }
      } catch {
        // Ignore errors for individual files
      }
    }

    // If still over size limit, delete oldest files
    const maxSizeBytes = MAX_CACHE_SIZE_MB * 1024 * 1024;
    if (totalSize > maxSizeBytes) {
      fileStats.sort((a, b) => a.mtime - b.mtime);
      for (const file of fileStats) {
        if (totalSize <= maxSizeBytes * 0.8) break; // Reduce to 80% of max
        try {
          unlinkSync(join(CACHE_DIR, file.name));
          totalSize -= file.size;
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

// Run cleanup periodically (every hour)
setInterval(() => {
  void cleanupCache();
}, TIME_MS.HOUR);
// Also run on startup
void cleanupCache();

/**
 * Fetch and proxy an image from a media server
 */
export async function proxyImage(options: ProxyOptions): Promise<ProxyResult> {
  const { serverId, imagePath, width = 300, height = 450, fallback = 'poster' } = options;

  // Check cache first
  const cacheKey = getCacheKey(serverId, imagePath, width, height);
  const cachePath = join(CACHE_DIR, cacheKey);

  if (existsSync(cachePath)) {
    try {
      const stat = statSync(cachePath);
      if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
        return {
          data: readFileSync(cachePath),
          contentType: 'image/webp',
          cached: true,
        };
      }
    } catch {
      // Cache miss, continue to fetch
    }
  }

  // Look up server
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);

  if (!server) {
    // Return fallback for missing server
    const fallbackSvg = getFallbackImage(fallback, width, height);
    return {
      data: fallbackSvg,
      contentType: 'image/svg+xml',
      cached: false,
    };
  }

  const token = server.token;

  // Build image URL based on server type
  let imageUrl: string;
  const headers: Record<string, string> = {};

  if (server.type === 'plex') {
    // Plex image URLs are relative paths like /library/metadata/123/thumb/456
    // Need to append X-Plex-Token
    const baseUrl = server.url.replace(/\/$/, '');
    const separator = imagePath.includes('?') ? '&' : '?';
    imageUrl = `${baseUrl}${imagePath}${separator}X-Plex-Token=${token}`;
    headers['Accept'] = 'image/*';
  } else {
    // Jellyfin - imagePath should include the full endpoint
    const baseUrl = server.url.replace(/\/$/, '');
    imageUrl = `${baseUrl}${imagePath}`;
    headers['X-Emby-Token'] = token;
    headers['Accept'] = 'image/*';
  }

  // Fetch image from server
  try {
    const response = await fetch(imageUrl, {
      headers,
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

    // Resize and convert to WebP using sharp
    const resized = await sharp(imageBuffer)
      .resize(width, height, {
        fit: 'cover',
        position: 'center',
      })
      .webp({ quality: 80 })
      .toBuffer();

    // Cache the result
    try {
      writeFileSync(cachePath, resized);
    } catch {
      // Cache write failure is non-fatal
    }

    return {
      data: resized,
      contentType: 'image/webp',
      cached: false,
    };
  } catch {
    // Return fallback on any error
    const fallbackSvg = getFallbackImage(fallback, width, height);
    return {
      data: fallbackSvg,
      contentType: 'image/svg+xml',
      cached: false,
    };
  }
}

/**
 * Get a gravatar URL for an email
 */
export function getGravatarUrl(email: string | null | undefined, size: number = 100): string {
  if (!email) {
    return ''; // Will use fallback
  }
  const hash = createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=mp`;
}
