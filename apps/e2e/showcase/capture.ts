/**
 * Shared bits of the capture run: posters arrive through the image proxy and
 * are decoded well after networkidle, and Playwright only writes png.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Page } from '@playwright/test';

const WEBP_QUALITY = 82;

export async function waitForImages(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      // Lazy images below the fold never start loading, so only the ones the
      // viewport can see are held to the loaded check.
      const visible = (img: HTMLImageElement) => {
        if (img.loading !== 'lazy') return true;
        const r = img.getBoundingClientRect();
        return (
          r.bottom > 0 &&
          r.top < window.innerHeight * 1.5 &&
          r.right > 0 &&
          r.left < window.innerWidth
        );
      };
      return Array.from(document.images)
        .filter(visible)
        .every((img) => img.complete && img.naturalWidth > 0);
    },
    undefined,
    { timeout }
  );
}

export async function writeWebp(png: Buffer, outPath: string): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  await sharp(png).webp({ quality: WEBP_QUALITY }).toFile(outPath);
}
