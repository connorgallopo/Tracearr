import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CUSTOM_LOGO_PATH = join(process.cwd(), 'data', 'logo.png');

let cachedMtimeMs: number | null = null;
let cachedPng: Buffer | null = null;

/** The owner's PNG logo when one is installed; the SVG fallback the web uses does not render in Gmail. */
export function readLogoPng(): Buffer | null {
  let mtimeMs: number | null;
  try {
    mtimeMs = statSync(CUSTOM_LOGO_PATH).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  if (mtimeMs !== cachedMtimeMs) {
    try {
      cachedPng = mtimeMs === null ? null : readFileSync(CUSTOM_LOGO_PATH);
      cachedMtimeMs = mtimeMs;
    } catch {
      // An unreadable logo is no logo; leaving the cached mtime alone retries on the next call.
      cachedPng = null;
    }
  }
  return cachedPng;
}
