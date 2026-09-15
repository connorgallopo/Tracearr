import { recordClientError } from './clientErrors';

const RELOAD_KEY = 'tracearr-chunk-reload';
const RELOAD_COOLDOWN_MS = 60_000;

function reloadedRecently(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    return Date.now() - last < RELOAD_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // private-mode storage; the cooldown is best effort
  }
}

export function installChunkReload(): void {
  window.addEventListener('vite:preloadError', (event) => {
    recordClientError('chunk preload', event.payload);
    if (reloadedRecently()) return;
    // Firefox caches the failed module fetch for the life of the document, so
    // re-importing the same URL cannot recover; only a fresh document can.
    event.preventDefault();
    markReloaded();
    window.location.reload();
  });
}
