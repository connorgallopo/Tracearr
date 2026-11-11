import { SERVER_PROFILES, assertNever, usernameAsEmail, type ServerType } from '@tracearr/shared';

/** The email for an account first seen in a session, which carries none: user sync fills it where the server reports one. */
export function emailForSessionUser(type: ServerType, username: string): string | null {
  const source = SERVER_PROFILES[type].emailSource;
  switch (source) {
    case 'server':
      return null;
    case 'username':
      return usernameAsEmail(username);
    default:
      return assertNever(source);
  }
}
