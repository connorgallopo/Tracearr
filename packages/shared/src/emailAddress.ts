import { z } from 'zod';

const address = z.email();

export function isEmailAddress(value: string): boolean {
  return address.safeParse(value).success;
}

/** Jellyfin and Emby expose no email, but a username is often one; lowercased like every stored address, null when it isn't one. */
export function usernameAsEmail(username: string): string | null {
  const candidate = username.trim();
  return candidate.length <= 254 && isEmailAddress(candidate) ? candidate.toLowerCase() : null;
}
