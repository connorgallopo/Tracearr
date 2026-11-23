import { APIError, getSessionFromCtx } from 'better-auth/api';

/** The signed-in owner's user id; anyone else, or an owner impersonating someone, is refused */
export async function requireOwnerSession(
  ctx: Parameters<typeof getSessionFromCtx>[0]
): Promise<string> {
  const current = await getSessionFromCtx(ctx);
  const role = (current?.user as { role?: string } | undefined)?.role;
  if (!current || current.session.impersonatedBy || role !== 'owner') {
    throw new APIError('FORBIDDEN', { message: 'Only the owner can add servers' });
  }
  return current.user.id;
}
