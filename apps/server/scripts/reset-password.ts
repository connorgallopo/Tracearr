#!/usr/bin/env node
/**
 * Emergency Owner Password Reset Script
 *
 * Resets the password for the owner user account, creating local
 * credential login even if the owner never had a password before (e.g. a
 * Plex-only owner). Requires direct Docker/server access and is intended
 * for emergency recovery.
 *
 * Usage:
 *   Interactive (prompts for password):
 *     docker exec -it tracearr node apps/server/dist/scripts/reset-password.js
 *
 *   With password argument (for automation):
 *     docker exec tracearr node apps/server/dist/scripts/reset-password.js "newPassword123"
 *
 *   Local development (via pnpm, after a build):
 *     pnpm reset-password
 *
 * For other recovery commands (set-username, set-email, list-users,
 * enable-local-login), see apps/server/scripts/cli.ts:
 *     pnpm --filter @tracearr/server cli <command>
 *
 * Owner Selection:
 *   First user (by created_at) with role='owner'
 */

import readline from 'readline';
import { eq, asc } from 'drizzle-orm';
import { db, users, resetPasswordCommand, shutdown } from './lib/commands.ts';

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Tracearr Emergency Password Reset');
  console.log('═══════════════════════════════════════════════════\n');

  try {
    const [owner] = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.role, 'owner'))
      .orderBy(asc(users.createdAt))
      .limit(1);

    if (!owner) {
      console.error('ERROR: No owner user found in the database.\n');
      console.error('This should not happen in a properly initialized Tracearr instance.');
      console.error('Please ensure you have completed the initial setup.\n');
      process.exitCode = 1;
      return;
    }

    console.log('Found owner user:');
    console.log(`   Username: ${owner.username}`);
    console.log(`   Email:    ${owner.email || '(not set)'}\n`);

    let password: string;

    if (process.argv[2]) {
      password = process.argv[2];
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      password = await new Promise<string>((resolvePrompt) => {
        rl.question('Enter new password: ', (answer) => {
          resolvePrompt(answer);
        });
      });
      rl.close();
    }

    if (password.length < 8) {
      console.error('\nERROR: Password must be at least 8 characters long.');
      process.exitCode = 1;
      return;
    }

    await resetPasswordCommand({ username: owner.username, password });

    console.log('\nPassword reset successfully!\n');
  } catch (error) {
    console.error('\nERROR: An error occurred during password reset:\n');
    if (error instanceof Error) {
      console.error(`   ${error.message}\n`);
      if (process.env.DEBUG) {
        console.error('Stack trace:');
        console.error(error.stack);
      }
    } else {
      console.error('   Unknown error occurred');
    }
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
}

main().catch((error: unknown) => {
  console.error('\nFatal error:', error);
  process.exit(1);
});
