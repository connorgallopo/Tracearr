function resolveBasePath(): string {
  const baseEl = document.querySelector('base');
  if (baseEl) {
    return new URL(baseEl.href).pathname.replace(/\/+$/, '');
  }
  return import.meta.env.BASE_URL.replace(/\/+$/, '');
}

/** e.g. "/tracearr" or "" */
export const BASE_PATH = resolveBasePath();

/** e.g. "/tracearr/" or "/" */
export const BASE_URL = BASE_PATH ? `${BASE_PATH}/` : '/';

/** Build image proxy URL using BASE_URL */
export function imageProxyUrl(
  serverId: string,
  path: string,
  width: number,
  height: number,
  fallback?: 'poster' | 'avatar'
): string {
  const params = new URLSearchParams({
    server: serverId,
    url: path,
    width: String(width),
    height: String(height),
  });
  if (fallback) params.set('fallback', fallback);
  return `${BASE_URL}api/v1/images/proxy?${params}`;
}
