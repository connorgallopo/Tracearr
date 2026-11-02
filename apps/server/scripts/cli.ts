#!/usr/bin/env node
/**
 * Tracearr Admin Recovery CLI
 *
 * Lockout-recovery commands for self-hosted installs (no email, no working
 * UI login). Run via direct Docker/server access.
 *
 * Usage:
 *   docker exec tracearr node apps/server/dist/scripts/cli.js <command> [args]
 *   pnpm --filter @tracearr/server cli <command> [args]
 *
 * Commands:
 *   reset-password [username] [--generate]    Reset a password (defaults to owner)
 *   set-username <current-identifier> <new>   Rename a user's login username
 *   set-email <username> <new-email>          Change a user's email
 *   list-users                                List users and their login methods
 *   enable-local-login                        Re-enable local username/password login
 */

import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import {
  resetPasswordCommand,
  setUsernameCommand,
  setEmailCommand,
  listUsersCommand,
  enableLocalLoginCommand,
  shutdown,
} from './lib/commands.ts';

const USAGE = `Tracearr Admin Recovery CLI

Usage:
  cli reset-password [username] [--generate]
  cli set-username <current-identifier> <new-username>
  cli set-email <username> <new-email>
  cli list-users
  cli enable-local-login
`;

function promptPassword(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePrompt) => {
    rl.question('Enter new password: ', (answer) => {
      rl.close();
      resolvePrompt(answer);
    });
  });
}

async function runResetPassword(args: string[]): Promise<void> {
  const generate = args.includes('--generate');
  const username = args.find((arg) => arg !== '--generate');

  const password = generate ? randomBytes(12).toString('base64url') : await promptPassword();

  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }

  await resetPasswordCommand({ username, password });

  console.log(`\nPassword reset successfully for ${username ?? 'the owner account'}.`);
  if (generate) {
    console.log(`Generated password: ${password}`);
  }
  console.log('All existing sessions for this account have been signed out.\n');
}

async function runSetUsername(args: string[]): Promise<void> {
  const [identifier, newUsername] = args;
  if (!identifier || !newUsername) {
    throw new Error('Usage: cli set-username <current-identifier> <new-username>');
  }
  await setUsernameCommand({ identifier, newUsername });
  console.log(`\nUsername updated: ${identifier} -> ${newUsername.toLowerCase()}\n`);
}

async function runSetEmail(args: string[]): Promise<void> {
  const [username, newEmail] = args;
  if (!username || !newEmail) {
    throw new Error('Usage: cli set-email <username> <new-email>');
  }
  await setEmailCommand({ username, newEmail });
  console.log(`\nEmail updated for ${username}: ${newEmail}\n`);
}

async function runListUsers(): Promise<void> {
  const rows = await listUsersCommand();
  console.log('\nusername             email                          role      login methods');
  console.log('-'.repeat(80));
  for (const row of rows) {
    const methods = row.loginMethods.length > 0 ? row.loginMethods.join(', ') : '(none)';
    console.log(
      `${row.username.padEnd(22)}${(row.email ?? '(not set)').padEnd(31)}${row.role.padEnd(10)}${methods}`
    );
  }
  console.log();
}

async function runEnableLocalLogin(): Promise<void> {
  await enableLocalLoginCommand();
  console.log('\nLocal username/password login is now enabled.\n');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  try {
    switch (command) {
      case 'reset-password':
        await runResetPassword(args);
        break;
      case 'set-username':
        await runSetUsername(args);
        break;
      case 'set-email':
        await runSetEmail(args);
        break;
      case 'list-users':
        await runListUsers();
        break;
      case 'enable-local-login':
        await runEnableLocalLogin();
        break;
      default:
        console.log(USAGE);
        process.exitCode = command ? 1 : 0;
    }
  } catch (error) {
    console.error(`\nERROR: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
}

void main();
