import {
  SERVER_PROFILES,
  assertNever,
  usernameAsEmail,
  type JellyfinEmbyServerType,
  type ServerType,
} from '@tracearr/shared';

export function hasSsePlugin(type: ServerType): type is JellyfinEmbyServerType {
  return SERVER_PROFILES[type].liveEvents === 'ssePlugin';
}

/** The email to store on a media server account, given the email the server reported for it. */
export function emailFromServer(
  type: ServerType,
  user: { username: string; email: string | null }
): string | null {
  const source = SERVER_PROFILES[type].emailSource;
  switch (source) {
    case 'server':
      return user.email;
    case 'username':
      return usernameAsEmail(user.username);
    default:
      return assertNever(source);
  }
}
