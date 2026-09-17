/**
 * Plex's modern guid (plex://movie/<id>, plex://episode/<id>) is stable across
 * re-keys, unlike the ratingKey. Legacy agent guids (com.plexapp.agents.*),
 * container types (show, season) and local://... are not linkable identities.
 */
export function normalizePlexGuid(
  guid: string | null | undefined
): { guid: string; mediaType: 'movie' | 'episode' } | null {
  if (!guid) return null;
  const stripped = guid.split('?')[0];
  if (!stripped) return null;

  const match = /^plex:\/\/(movie|episode)\/(.+)$/.exec(stripped);
  if (!match) return null;

  const [, mediaType, id] = match;
  if (!mediaType || !id) return null;

  return { guid: stripped, mediaType: mediaType as 'movie' | 'episode' };
}
