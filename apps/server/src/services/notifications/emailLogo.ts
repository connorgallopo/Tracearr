import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CUSTOM_LOGO_PATH = join(process.cwd(), 'data', 'logo.png');

/** The owner's PNG logo when one is installed; the SVG fallback the web uses does not render in Gmail. */
export function readLogoPng(): Buffer | null {
  try {
    return readFileSync(CUSTOM_LOGO_PATH);
  } catch {
    return null;
  }
}
