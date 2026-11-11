import { toast } from 'sonner';
import { SIGN_IN_ERROR_CODES } from '@tracearr/shared';
import { ApiError } from '@/lib/api';

/** Why a Plex or tofa sign-in stopped, shown inline where it happened. */
export type SignInFailure = {
  /** failed: the sign-in could not start or finish, with the server's reason when it gave one. */
  kind: 'expired' | 'timed-out' | 'connect-failed' | 'failed';
  message?: string;
};

/** A refused sign-in that keeps the server's error code, which decides how it is shown. */
export class SignInError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'SignInError';
    this.code = code;
  }
}

function errorCode(error: unknown): unknown {
  if (error instanceof SignInError) return error.code;
  if (error instanceof ApiError) return error.body.code;
  return undefined;
}

/** The person proved who they are but the owner keeps them out: told in a toast, not inline. */
export function isNotPermitted(error: unknown): boolean {
  return errorCode(error) === SIGN_IN_ERROR_CODES.notPermitted;
}

/** The server no longer holds the sign-in the browser is finishing; it has to be started again. */
export function isSignInExpired(error: unknown): boolean {
  return errorCode(error) === SIGN_IN_ERROR_CODES.signInExpired;
}

export function toastNotPermitted(message: string): void {
  toast.error(message, { id: SIGN_IN_ERROR_CODES.notPermitted });
}
