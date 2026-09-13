import { BASE_PATH } from '@/lib/api';
import { API_BASE_PATH } from '@tracearr/shared';

/**
 * Simple fetch helper for debug endpoints
 */
export async function debugFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {};
  // Only set Content-Type for requests with a body
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }
  // Merge additional headers if provided as a plain object
  if (options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)) {
    Object.assign(headers, options.headers);
  }
  const res = await fetch(`${BASE_PATH}${API_BASE_PATH}/debug${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Raw fetch for debug endpoints (e.g. file downloads)
 */
export async function debugRawFetch(path: string): Promise<Response> {
  const res = await fetch(`${BASE_PATH}${API_BASE_PATH}/debug${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}
