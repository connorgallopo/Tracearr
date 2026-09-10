import { relative, resolve, sep } from 'node:path';

/**
 * Resolve a request path to a file inside the web root, or null if it escapes.
 *
 * Returns the root-relative path to hand to reply.sendFile, so the containment
 * check and the thing actually served are derived from one place - a predicate
 * plus a separately-computed path can disagree, which is the bug this avoids.
 */
export function resolveWebAsset(root: string, urlPath: string): string | null {
  // A protocol-relative or double-slash path is never a legitimate asset
  // request and is the form that smuggles an absolute path past resolve().
  if (!urlPath.startsWith('/') || urlPath.startsWith('//')) return null;

  // Decode before validating: request.url is raw, so %2f would otherwise reach
  // resolve() as a literal directory name and sail through the containment
  // check while still meaning "../" to anything that decodes it later.
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.startsWith('//')) return null;

  const resolvedRoot = resolve(root);
  const fullPath = resolve(resolvedRoot, decoded.slice(1));
  if (fullPath !== resolvedRoot && !fullPath.startsWith(resolvedRoot + sep)) return null;

  return relative(resolvedRoot, fullPath).split(sep).join('/');
}
