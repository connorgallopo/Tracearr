import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CUSTOM_LOGO_PATH = join(process.cwd(), 'data', 'logo.png');
/** Five directories above services/notifications is the repo root under pnpm dev and /app in the image; src and dist sit at the same depth. */
export const BUNDLED_LOGO_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../assets/logo.png'
);

let cachedPath: string | null = null;
let cachedMtimeMs: number | null = null;
let cachedPng: Buffer | null = null;

function locate(): { path: string; mtimeMs: number } | null {
  for (const path of [CUSTOM_LOGO_PATH, BUNDLED_LOGO_PATH]) {
    try {
      return { path, mtimeMs: statSync(path).mtimeMs };
    } catch {
      continue;
    }
  }
  return null;
}

/** The owner's data/logo.png when one is installed, otherwise the bundled Tracearr mark. */
export function logoPngPath(): string | null {
  return locate()?.path ?? null;
}

/** The PNG behind cid:logo and /images/logo; never the SVG, which Gmail does not render. */
export function readLogoPng(): Buffer | null {
  const found = locate();
  const path = found?.path ?? null;
  const mtimeMs = found?.mtimeMs ?? null;
  if (path !== cachedPath || mtimeMs !== cachedMtimeMs) {
    try {
      cachedPng = path === null ? null : readFileSync(path);
      cachedPath = path;
      cachedMtimeMs = mtimeMs;
    } catch {
      // An unreadable logo is no logo; leaving the cache key alone retries on the next call.
      cachedPng = null;
    }
  }
  return cachedPng;
}
