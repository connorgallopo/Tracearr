/** Release builds carry a dotted version; every other channel appends a commit hash. */
export function shortVersion(version: string): string {
  if (/^\d+(\.\d+)+$/.test(version)) return version;
  const [channel] = version.split('-');
  return channel ?? version;
}
