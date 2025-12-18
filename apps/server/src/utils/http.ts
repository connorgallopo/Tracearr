/**
 * HTTP Client Utilities
 *
 * Provides a consistent interface for making HTTP requests with:
 * - Automatic error handling and typed errors
 * - Service-specific error codes integration
 * - Support for JSON, text, and raw response handling
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

/**
 * Options for HTTP requests
 */
export interface HttpRequestOptions extends Omit<RequestInit, 'signal'> {
  /** Service name for error messages */
  service?: string;
  /** Request timeout in milliseconds */
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
  const { timeout, ...fetchOptions } = options;

  const response = await fetch(url, {
    ...fetchOptions,
    signal: timeout ? createTimeoutSignal(timeout) : undefined,
  });

  await assertResponseOk(response, url, options);

  return response.json() as Promise<T>;
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
  const { timeout, ...fetchOptions } = options;

  const response = await fetch(url, {
    ...fetchOptions,
    signal: timeout ? createTimeoutSignal(timeout) : undefined,
  });

  await assertResponseOk(response, url, options);

  return response.text();
}

/**
 * Fetch raw Response object (for streaming, binary data, etc.)
 * Still validates response.ok
 *
 * @example
 * const response = await fetchRaw('https://api.example.com/image.png', {
 *   service: 'example'
 * });
 * const buffer = await response.arrayBuffer();
 */
export async function fetchRaw(url: string, options: HttpRequestOptions = {}): Promise<Response> {
  const { timeout, ...fetchOptions } = options;

  const response = await fetch(url, {
    ...fetchOptions,
    signal: timeout ? createTimeoutSignal(timeout) : undefined,
  });

  await assertResponseOk(response, url, options);

  return response;
}

/**
 * Fetch with full response info (status, headers, body)
 * Does NOT throw on non-2xx responses
 *
 * @example
 * const { ok, status, data } = await fetchWithStatus<User>('https://api.example.com/user');
 * if (!ok) {
 *   console.log('Request failed with status', status);
 * }
 */
export async function fetchWithStatus<T>(
  url: string,
  options: HttpRequestOptions = {}
): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  data: T | null;
}> {
  const { timeout, ...fetchOptions } = options;

  const response = await fetch(url, {
    ...fetchOptions,
    signal: timeout ? createTimeoutSignal(timeout) : undefined,
  });

  let data: T | null = null;
  if (response.ok) {
    try {
      data = (await response.json()) as T;
    } catch {
      // Response might not be JSON
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    data,
  };
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
export function plexHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Plex-Client-Identifier': 'tracearr',
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
 * Helper to create Jellyfin-specific headers
 */
export function jellyfinHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (apiKey) {
    headers['X-Emby-Token'] = apiKey;
  }

  return headers;
}

/**
 * Helper to create Emby-specific headers
 * Note: Emby uses the same X-Emby-Token header as Jellyfin (Jellyfin forked from Emby)
 */
export function embyHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (apiKey) {
    headers['X-Emby-Token'] = apiKey;
  }

  return headers;
}
