/**
 * HTTP Client Utilities
 *
 * Provides a consistent interface for making HTTP requests with:
 * - Automatic error handling and typed errors
 * - Service-specific error codes integration
 * - Support for JSON and text response handling
 * - Request timeout support
 */

import { ExternalServiceError } from './errors.js';

/**
 * HTTP client error with service context
 */
export class HttpClientError extends Error {
  public readonly statusCode: number;
  public readonly statusText: string;
  public readonly service: string;
  public readonly url: string;
  public readonly responseBody?: string;

  constructor(options: {
    service: string;
    statusCode: number;
    statusText: string;
    url: string;
    message?: string;
    responseBody?: string;
  }) {
    const message =
      options.message ||
      `${options.service} request failed: ${options.statusCode} ${options.statusText}`;
    super(message);
    this.name = 'HttpClientError';
    this.service = options.service;
    this.statusCode = options.statusCode;
    this.statusText = options.statusText;
    this.url = options.url;
    this.responseBody = options.responseBody;

    Error.captureStackTrace(this, this.constructor);
    Object.setPrototypeOf(this, HttpClientError.prototype);
  }

  /**
   * Convert to ExternalServiceError for known services
   */
  toExternalServiceError(): ExternalServiceError | this {
    if (
      this.service === 'plex' ||
      this.service === 'jellyfin' ||
      this.service === 'emby' ||
      this.service === 'geoip'
    ) {
      return new ExternalServiceError(this.service, this.message);
    }
    return this;
  }
}

export function isHttpStatus(error: unknown, ...statuses: number[]): boolean {
  return error instanceof HttpClientError && statuses.includes(error.statusCode);
}

/**
 * Options for HTTP requests
 */
export interface HttpRequestOptions extends Omit<RequestInit, 'signal'> {
  /** Service name for error messages */
  service?: string;
  /** Request timeout in milliseconds. Defaults to 30 s; 0 disables it. */
  timeout?: number;
  /** Whether to include response body in errors */
  includeBodyInError?: boolean;
}

/**
 * Check if response is OK, throw HttpClientError if not
 */
async function assertResponseOk(
  response: Response,
  url: string,
  options: HttpRequestOptions
): Promise<void> {
  if (response.ok) return;

  let responseBody: string | undefined;
  if (options.includeBodyInError) {
    try {
      responseBody = await response.text();
    } catch {
      // Ignore - body might already be consumed or unavailable
    }
  }

  throw new HttpClientError({
    service: options.service || 'API',
    statusCode: response.status,
    statusText: response.statusText,
    url,
    responseBody,
  });
}

/**
 * Create an AbortSignal with timeout
 */
function createTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

const TIMEOUT_PATH_MAX = 120;

/**
 * The bare abort says only that something timed out; this names the request. Still a
 * TimeoutError DOMException, which callers test for. Path only: some callers put a
 * token in the query string.
 */
function namedTimeout(error: unknown, url: string, options: HttpRequestOptions, timeout: number) {
  if (!(error instanceof DOMException) || error.name !== 'TimeoutError') return error;
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // not an absolute URL; the fetch would have failed before timing out
  }
  if (path.length > TIMEOUT_PATH_MAX) path = `${path.slice(0, TIMEOUT_PATH_MAX)}...`;
  return new DOMException(
    `${options.service || 'API'} request to ${path} timed out after ${timeout / 1000}s`,
    'TimeoutError'
  );
}

/**
 * Fetch JSON data from a URL
 *
 * @example
 * const data = await fetchJson<UserResponse>('https://api.example.com/user', {
 *   service: 'example',
 *   headers: { 'Authorization': 'Bearer token' }
 * });
 */
export async function fetchJson<T>(url: string, options: HttpRequestOptions = {}): Promise<T> {
  const { timeout = 30_000, ...fetchOptions } = options;

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: timeout ? createTimeoutSignal(timeout) : undefined,
    });

    await assertResponseOk(response, url, options);

    return (await response.json()) as T;
  } catch (error) {
    throw namedTimeout(error, url, options, timeout);
  }
}

/**
 * Fetch text content from a URL
 *
 * @example
 * const xml = await fetchText('https://api.example.com/data.xml', {
 *   service: 'example'
 * });
 */
export async function fetchText(url: string, options: HttpRequestOptions = {}): Promise<string> {
  const { timeout = 30_000, ...fetchOptions } = options;

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: timeout ? createTimeoutSignal(timeout) : undefined,
    });

    await assertResponseOk(response, url, options);

    return await response.text();
  } catch (error) {
    throw namedTimeout(error, url, options, timeout);
  }
}

/**
 * Helper to create common headers for JSON APIs
 */
export function jsonHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
}

/**
 * Helper to create Plex-specific headers
 */
// plex.tv scopes a PIN to the identifier that created it - polling with a
// different one returns 404/1020. A constant shared by every install therefore
// lets any install redeem any other's PIN. Loaded from settings at startup;
// the legacy value is only the pre-startup fallback. Public, never a secret.
let plexClientIdentifier = 'tracearr';

export function setPlexClientIdentifier(id: string): void {
  plexClientIdentifier = id;
}

export function getPlexClientIdentifier(): string {
  return plexClientIdentifier;
}

export function plexHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Plex-Client-Identifier': plexClientIdentifier,
    'X-Plex-Product': 'Tracearr',
    'X-Plex-Version': '1.0.0',
    'X-Plex-Device': 'Server',
    'X-Plex-Platform': 'Node.js',
  };

  if (token) {
    headers['X-Plex-Token'] = token;
  }

  return headers;
}

/**
 * Helper to create Jellyfin/Emby-specific headers
 * Note: Both use identical X-Emby-Token header (Jellyfin forked from Emby)
 */
export function jellyfinEmbyHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (apiKey) {
    headers['X-Emby-Token'] = apiKey;
  }

  return headers;
}

/** @deprecated Use jellyfinEmbyHeaders instead - kept for backward compatibility */
export const jellyfinHeaders = jellyfinEmbyHeaders;

/** @deprecated Use jellyfinEmbyHeaders instead - kept for backward compatibility */
export const embyHeaders = jellyfinEmbyHeaders;
